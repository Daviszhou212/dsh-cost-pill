/**
 * 会话树发现单测：复刻真实磁盘布局
 * `<DSH_HOME>/sessions/<工作区目录>/<会话目录>/session.v3.jsonl.zstd`，
 * 覆盖上一版漏测的路径发现逻辑（工作区层、`session-` 前缀目录名），并让真实
 * 入口 `apply()` 注册的树路由在假 DSH_HOME 下走完全流程。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { apply, TREE_PATH } from '../lib/index.js'
import { findWorkspaceDir, sessionLogFile, sessionsRoot } from '../lib/tree.js'

/** 一个 2026-09-10（周四）北京 20:00 = 空闲时段的时间戳。 */
const OFFPEAK_TIME = Date.UTC(2026, 8, 10, 12, 0)

/** 造一个单帧 zstd 的会话日志。 */
function writeLog(dir, header, events = []) {
	mkdirSync(dir, { recursive: true })
	const lines = [JSON.stringify({ type: 'session', version: 3, cwd: 'D:\\Test', ...header }), ...events.map((event) => JSON.stringify(event))]
	writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
}

/** 一个计费样本事件（空闲时段 100k 未命中输入 + 100k 输出 = 0.5 元）。 */
function usageEvent(time = OFFPEAK_TIME) {
	return {
		type: 'assistant/message',
		time,
		data: {
			usage: { inputTokens: 100_000, outputTokens: 100_000 },
			message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }
		}
	}
}

/**
 * 布一个工作区、两代子代理、一个普通 fork、另一个不相干工作区：
 *
 *   <root>/sessions/--Test-Proj--/session-root-aaa/…   顶层会话（带前缀目录名）
 *   <root>/sessions/--Test-Proj--/child-bbb/…          depth 1 子代理
 *   <root>/sessions/--Test-Proj--/grand-ccc/…          depth 2 子代理
 *   <root>/sessions/--Test-Proj--/fork-ddd/…           origin 缺省 → 不算子代理
 *   <root>/sessions/--Other-Proj--/other-eee/…         别的工作区 → 不在树里
 */
function layout(root) {
	const ws = join(root, 'sessions', '--Test-Proj--')
	writeLog(join(ws, 'session-root-aaa'), { id: 'session-root-aaa', createdAt: 1, delegationDepth: 0 }, [usageEvent()])
	writeLog(join(ws, 'child-bbb'), { id: 'child-bbb', createdAt: 2, parentSession: 'session-root-aaa', origin: 'subagent', delegationDepth: 1 }, [usageEvent()])
	writeLog(join(ws, 'grand-ccc'), { id: 'grand-ccc', createdAt: 3, parentSession: 'child-bbb', origin: 'subagent', delegationDepth: 2 }, [usageEvent()])
	writeLog(join(ws, 'fork-ddd'), { id: 'fork-ddd', createdAt: 4, parentSession: 'session-root-aaa', delegationDepth: 0 }, [usageEvent()])
	writeLog(join(root, 'sessions', '--Other-Proj--', 'other-eee'), { id: 'other-eee', createdAt: 5, parentSession: 'session-root-aaa', origin: 'subagent', delegationDepth: 1 }, [usageEvent()])
	return ws
}

/** 带假 DSH_HOME 跑一段异步函数。 */
function withFakeHome(root, fn) {
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = root
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (previous === undefined) delete process.env.DSH_HOME
			else process.env.DSH_HOME = previous
		})
}

async function register() {
	let routes = []
	const ctx = {
		sessionProjections: { register() {} },
		webServer: { register(row) { routes.push(row) } },
		effect(fn) { return fn() },
		get(name) {
			if (name === 'settings') return { get: () => undefined }
			if (name === 'credentials') return { resolve: async () => ({ value: '' }) }
			return undefined
		}
	}
	await apply(ctx, { balance: { enabled: false } })
	return routes.find((row) => row.path === TREE_PATH)
}

test('sessionsRoot：未设 DSH_HOME 时落在 ~/.dsh/sessions（对齐 dsh-home-paths 约定）', () => {
	const previous = process.env.DSH_HOME
	delete process.env.DSH_HOME
	try {
		assert.equal(sessionsRoot(), join(process.env.USERPROFILE ?? tmpdir(), '.dsh', 'sessions'))
	} finally {
		if (previous !== undefined) process.env.DSH_HOME = previous
	}
})

test('findWorkspaceDir：穿透工作区层，两种会话目录名都命中', () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-cost-pill-tree-'))
	try {
		layout(root)
		assert.notEqual(findWorkspaceDir(join(root, 'sessions'), 'root-aaa'), undefined, '裸 id（实际目录带前缀）')
		assert.equal(findWorkspaceDir(join(root, 'sessions'), 'root-aaa'), join(root, 'sessions', '--Test-Proj--'))
		assert.equal(findWorkspaceDir(join(root, 'sessions'), 'session-root-aaa'), join(root, 'sessions', '--Test-Proj--'), '带前缀 id')
		assert.equal(findWorkspaceDir(join(root, 'sessions'), 'child-bbb'), join(root, 'sessions', '--Test-Proj--'))
		assert.equal(findWorkspaceDir(join(root, 'sessions'), 'no-such-session'), undefined)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('sessionLogFile：需要工作区目录；前缀/裸目录名都能解析', () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-cost-pill-tree-'))
	try {
		const ws = layout(root)
		assert.equal(sessionLogFile(ws, 'root-aaa'), join(ws, 'session-root-aaa', 'session.v3.jsonl.zstd'))
		assert.equal(sessionLogFile(ws, 'session-root-aaa'), join(ws, 'session-root-aaa', 'session.v3.jsonl.zstd'))
		assert.equal(sessionLogFile(ws, 'child-bbb'), join(ws, 'child-bbb', 'session.v3.jsonl.zstd'))
		const missing = sessionLogFile(ws, 'no-such-session')
		assert.equal(missing, join(ws, 'no-such-session', 'session.v3.jsonl.zstd'), '未落盘会话返回规范路径')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('树路由：真实布局下汇总本会话 + 整棵子代理树；fork 与别的工作区不计入', async () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-cost-pill-tree-'))
	try {
		layout(root)
		await withFakeHome(root, async () => {
			const route = await register()
			assert.ok(route, 'balance 关闭时树路由仍必须注册（两功能独立）')
			const res = { captured: {} }
			res.writeHead = (status, headers) => { res.captured.status = status; res.captured.headers = headers }
			res.end = (body) => { res.captured.body = body }
			await route.handler(
				{
					method: 'GET',
					url: TREE_PATH + '?session=' + encodeURIComponent('session-root-aaa'),
					headers: { host: '127.0.0.1:3080' },
					socket: { remoteAddress: '127.0.0.1' }
				},
				res
			)
			assert.equal(res.captured.status, 200)
			const payload = JSON.parse(res.captured.body)
			assert.equal(payload.ok, true, '工作区必须能被定位（回归：路径缺工作区层时这里永远是 workspace-not-found）')
			assert.equal(payload.sessionId, 'root-aaa')
			// own + child + grand = 3 × 0.5；fork（非 subagent）与别的工作区不入树
			assert.equal(payload.subagents.count, 2)
			assert.equal(Number(payload.own.cost.toFixed(6)), 0.5)
			assert.equal(Number(payload.subagents.cost.toFixed(6)), 1)
			assert.equal(Number(payload.total.toFixed(6)), 1.5)
			assert.equal(payload.samples, 1)
		})
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('树路由：未知会话给 workspace-not-found，不炸 500', async () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-cost-pill-tree-'))
	try {
		layout(root)
		await withFakeHome(root, async () => {
			const route = await register()
			const res = { captured: {} }
			res.writeHead = (status) => { res.captured.status = status }
			res.end = (body) => { res.captured.body = body }
			await route.handler(
				{
					method: 'GET',
					url: TREE_PATH + '?session=no-such-session',
					headers: { host: '127.0.0.1:3080' },
					socket: { remoteAddress: '127.0.0.1' }
				},
				res
			)
			assert.equal(res.captured.status, 200)
			const payload = JSON.parse(res.captured.body)
			assert.equal(payload.ok, false)
			assert.equal(payload.error, 'workspace-not-found')
		})
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
