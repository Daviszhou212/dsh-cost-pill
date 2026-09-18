/**
 * dsh-cost-pill · 会话树发现与折叠（宿主侧）
 *
 * 子代理（subagent）是**独立会话**：各自的持久日志、各自的 usage 样本。但账单是
 * 从同一个余额里扣的 —— 用户眼里「这个会话花了多少钱」应当包含它派生的整棵子代理树。
 *
 * 关联数据在会话头部事件里：`parentSession`（注意：一级子代理带 `session-` 前缀，
 * 更深的层级用裸 id，所以匹配前要归一化）、`origin: 'subagent'`、`delegationDepth`。
 *
 * 性能：日志是追加式多帧 zstd。按 (会话日志 mtime) 做增量缓存 —— 文件没变就复用
 * 已折叠的状态，变了才重读重折。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { applyEvent, initialState } from './pricing.js'

export const SESSION_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 归一化会话 id：去掉 `session-` 前缀（树里父子两代写法不一致）。 */
export function normalizeSessionId(id) {
	return String(id ?? '').replace(/^session-/, '')
}

/** 多帧 zstd → 文本（追加式日志每次追加写一个新帧，逐帧解压）。 */
export function decompressFrames(buffer) {
	const offsets = []
	for (let i = 0; (i = buffer.indexOf(SESSION_MAGIC, i)) >= 0; i++) offsets.push(i)
	let text = ''
	let cursor = 0
	while (cursor < offsets.length) {
		let decoded = false
		for (let end = cursor + 1; end <= offsets.length; end++) {
			const stop = end < offsets.length ? offsets[end] : buffer.length
			try {
				text += zstdDecompressSync(buffer.subarray(offsets[cursor], stop)).toString('utf8')
				cursor = end
				decoded = true
				break
			} catch {
				/* 尝试下一个切点 */
			}
		}
		if (!decoded) break
	}
	return text
}

/** DSH 会话根目录。 */
export function sessionsRoot() {
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : homedir()
	return join(home, 'sessions')
}

/** 某会话的持久日志路径。 */
export function sessionLogFile(sessionId) {
	return join(sessionsRoot(), normalizeSessionId(sessionId), 'session.v3.jsonl.zstd')
}

/** 解析一段日志文本 → 事件数组（坏行跳过）。 */
export function parseEvents(text) {
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => {
			try {
				return JSON.parse(line)
			} catch {
				return null
			}
		})
		.filter((event) => event !== null)
}

/** 日志首行（type === 'session' 的头部事件）。 */
export function headerOf(text) {
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const event = JSON.parse(line)
			if (event.type === 'session') return event
		} catch {}
	}
	return undefined
}

/**
 * 在会话根目录下定位某个会话的工作区目录：
 * 目录名就是 `normalizeSessionId(sessionId)`。
 */
export function findWorkspaceDir(sessionsRootDir, sessionId) {
	const dir = join(sessionsRootDir, normalizeSessionId(sessionId))
	try {
		statSync(dir)
		return dir
	} catch {
		return undefined
	}
}

/** 列出工作区里所有会话的头部（id / parentSession / origin / depth / logPath）。 */
export function listWorkspaceSessions(workspaceDir) {
	const out = []
	for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		const logPath = join(workspaceDir, entry.name, 'session.v3.jsonl.zstd')
		try {
			const header = headerOf(decompressFrames(readFileSync(logPath)))
			if (header === undefined) continue
			out.push({
				id: normalizeSessionId(header.id ?? entry.name),
				parent: normalizeSessionId(header.parentSession),
				origin: header.origin,
				depth: header.delegationDepth,
				logPath,
				createdAt: header.createdAt
			})
		} catch {
			/* 读不了的会话跳过 */
		}
	}
	return out
}

/**
 * 从根会话出发收集整棵子代理树（含根），返回归一化 id 集合。
 * 只把 `origin === 'subagent'` 的会话算作子节点 —— 普通 fork 的历史属于分支会话
 * 自己，不该双算进父会话。
 */
export function collectTree(sessions, rootId) {
	const root = normalizeSessionId(rootId)
	const byParent = new Map()
	for (const session of sessions) {
		if (session.origin !== 'subagent') continue
		const list = byParent.get(session.parent) ?? []
		list.push(session.id)
		byParent.set(session.parent, list)
	}
	const found = new Set([root])
	const queue = [root]
	while (queue.length > 0) {
		const current = queue.shift()
		for (const child of byParent.get(current) ?? []) {
			if (!found.has(child)) {
				found.add(child)
				queue.push(child)
			}
		}
	}
	return found
}

/** 折叠一段日志文本 → 投影状态（复用 pricing.js 的纯折叠）。 */
export function foldText(text, state) {
	for (const event of parseEvents(text)) state = applyEvent(state, event)
	return state
}

/** 折叠整个日志文件 → 状态。 */
export function foldFile(logPath, state) {
	return foldText(decompressFrames(readFileSync(logPath)), state)
}

export { initialState }
