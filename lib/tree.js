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

/**
 * DSH 会话根目录。DSH 的家目录约定是 `${DSH_HOME:-$HOME/.dsh}`（见 dsh-home-paths），
 * 未设 DSH_HOME 时默认在 `~/.dsh` 下 —— 不能直接用裸 homedir。
 */
export function sessionsRoot() {
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'sessions')
}

/** 某会话日志在**工作区目录**下的实际路径。
 *
 * 目录名有两个历史写法：顶层会话带 `session-` 前缀，子代理会话用裸 id —— 两种都
 * 探测；都没命中（日志还没落盘的活会话）时返回裸 id 的规范路径，让调用方按
 * 「文件不存在」处理。
 */
export function sessionLogFile(workspaceDir, sessionId) {
	const bare = normalizeSessionId(sessionId)
	for (const name of [bare, `session-${bare}`]) {
		const logPath = join(workspaceDir, name, 'session.v3.jsonl.zstd')
		try {
			if (statSync(logPath).isFile()) return logPath
		} catch {
			/* 试下一种写法 */
		}
	}
	return join(workspaceDir, bare, 'session.v3.jsonl.zstd')
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
 * 在会话根目录下定位某个会话所属的**工作区目录**。
 *
 * 真实布局是 `sessions/<工作区目录>/<会话目录>/session.v3.jsonl.zstd`（工作区目录
 * 形如 `--D-ARIS-Aircomp--`，由 cwd 转写而来）—— 会话目录不直接挂在根上。这里扫
 * 根目录的每个子目录，探测 `<工作区>/<裸 id>` 与 `<工作区>/session-<裸 id>` 两种
 * 会话目录写法，命中即返回该工作区目录。
 */
export function findWorkspaceDir(sessionsRootDir, sessionId) {
	const bare = normalizeSessionId(sessionId)
	let entries
	try {
		entries = readdirSync(sessionsRootDir, { withFileTypes: true })
	} catch {
		return undefined
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const workspace = join(sessionsRootDir, entry.name)
		for (const name of [bare, `session-${bare}`]) {
			try {
				if (statSync(join(workspace, name)).isDirectory()) return workspace
			} catch {
				/* 试下一种写法 */
			}
		}
	}
	return undefined
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

/**
 * 只读日志头部：头部永远是日志的**第一个事件**（persistHeader 先于一切批次落盘），
 * 在第一个 zstd 帧里解出来即可 —— 为读 200 字节的头去解压整本几 MB 的日志太浪费
 * （listWorkspaceSessions 每个刷新周期都要把工作区全部会话的头读一遍）。
 * 第一帧切分失败或头不在首帧时回退到整本解压，保证不比旧实现差。
 */
export function headerOfLog(logPath) {
	let buffer
	try {
		buffer = readFileSync(logPath)
	} catch {
		return undefined
	}
	const start = buffer.indexOf(SESSION_MAGIC)
	if (start >= 0) {
		const next = buffer.indexOf(SESSION_MAGIC, start + SESSION_MAGIC.length)
		try {
			const header = headerOf(zstdDecompressSync(buffer.subarray(start, next === -1 ? buffer.length : next)).toString('utf8'))
			if (header !== undefined) return header
		} catch {
			/* 首帧切分失败（magic 巧合出现在帧内）→ 整本解压 */
		}
	}
	try {
		return headerOf(decompressFrames(buffer))
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
		const header = headerOfLog(logPath)
		if (header === undefined) continue
		out.push({
			id: normalizeSessionId(header.id ?? entry.name),
			parent: normalizeSessionId(header.parentSession),
			origin: header.origin,
			depth: header.delegationDepth,
			logPath,
			createdAt: header.createdAt
		})
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
