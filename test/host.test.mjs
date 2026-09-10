/**
 * 宿主半边单测：用一个假的 ctx 捕获投影定义与余额路由，验证注册契约成立，并让真实
 * 入口 `apply()` 走完「折叠 → 折算」与「路由 → 凭据 → 上游 → 响应」两条全流程。
 *
 * 注意：这里也顺带覆盖「schemastery 不可解析 → 退化为直通 schema」这条路径
 * （本地 link 安装的插件，其依赖不一定能沿 node_modules 链找到）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, BALANCE_PATH, PROJECTION_KEY, STATE_VERSION } from '../lib/index.js'

/**
 * 用假 ctx 跑 apply()。
 *
 * @param config - 插件行 config。
 * @param options - `{ apiKey }`：假凭据缝返回值；`''` 表示没有配 Key。
 * @returns `{ definition, route }`。
 */
async function register(config, options = {}) {
	const apiKey = options.apiKey === undefined ? 'sk-test' : options.apiKey
	let definition
	let route
	const ctx = {
		sessionProjections: {
			register(def) {
				definition = def
				return () => {}
			}
		},
		webServer: {
			register(row) {
				route = row
				return () => {}
			}
		},
		effect(fn) {
			return fn()
		},
		get(name) {
			if (name === 'settings') return { get: (ns) => (ns === 'llm-deepseek' ? {} : undefined) }
			if (name === 'credentials') return { resolve: async () => ({ value: apiKey }) }
			return undefined
		}
	}
	await apply(ctx, config)
	return { definition, route }
}

/** 造一个假响应对象，收集 writeHead/end。 */
function fakeResponse() {
	const captured = { status: undefined, headers: undefined, body: undefined }
	return {
		captured,
		writeHead(status, headers) {
			captured.status = status
			captured.headers = headers
		},
		end(body) {
			captured.body = body
		}
	}
}

/** 造一个假请求；默认是本机 GET。 */
function fakeRequest(overrides = {}) {
	return {
		method: 'GET',
		url: BALANCE_PATH,
		headers: { host: '127.0.0.1:3080' },
		socket: { remoteAddress: '127.0.0.1' },
		...overrides
	}
}

/** 临时替换 globalThis.fetch，返回调用计数。 */
function stubFetch(impl) {
	const original = globalThis.fetch
	let calls = 0
	globalThis.fetch = async (...args) => {
		calls += 1
		return impl(...args)
	}
	return {
		count: () => calls,
		restore: () => {
			globalThis.fetch = original
		}
	}
}

const BALANCE_BODY = {
	is_available: true,
	balance_infos: [{ currency: 'CNY', total_balance: '107.54', granted_balance: '0.00', topped_up_balance: '107.54' }]
}


test('注册契约：key / stateVersion / schema / init / apply / wire 齐备', async () => {
	const { definition: def } = await register(undefined)
	assert.equal(def.key, PROJECTION_KEY)
	assert.equal(def.stateVersion, STATE_VERSION)
	assert.equal(typeof def.init, 'function')
	assert.equal(typeof def.apply, 'function')
	assert.equal(typeof def.stateSchema.parse, 'function')
	assert.equal(typeof def.wire.view, 'function')
	assert.equal(typeof def.wire.viewSchema.parse, 'function')

	// 注册表只用到 .parse()，两种 schema 都必须能直接 parse 初值与视图
	const state = def.init({}, 0)
	assert.deepEqual(def.stateSchema.parse(state), state)
	const view = def.wire.viewSchema.parse(def.wire.view(state))
	assert.equal(view.cost, 0)
	assert.equal(view.samples, 0)
})

test('端到端：apply() → 折叠 → 视图，金额随定价覆盖生效', async () => {
	const { definition: def } = await register({
		pricing: {
			'acme/x': {
				offpeak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 4 },
				peak: { input: 2, cacheRead: 0, cacheWrite: 0, output: 8 }
			}
		}
	})

	const event = (time, usage) => ({
		type: 'assistant/message',
		time,
		data: { usage, message: { source: { provider: 'acme', model: 'x' } } }
	})

	let state = def.init({}, 0)
	// 北京时间 2026-09-10（周四）09:00 = UTC 01:00 → 高峰
	state = def.apply(state, event(Date.UTC(2026, 8, 10, 1, 0), { inputTokens: 1_000_000 }))
	// 北京时间同日 20:00 → 空闲
	state = def.apply(state, event(Date.UTC(2026, 8, 10, 12, 0), { inputTokens: 1_000_000 }))

	const view = def.wire.viewSchema.parse(def.wire.view(state))
	assert.equal(view.samples, 2)
	assert.equal(Number(view.peakCost.toFixed(4)), 2) // 1M × 2 元/百万
	assert.equal(Number(view.offpeakCost.toFixed(4)), 1) // 1M × 1 元/百万
	assert.equal(Number(view.cost.toFixed(4)), 3)
	assert.equal(view.models.length, 1)
	assert.equal(view.models[0].key, 'acme/x')
	assert.deepEqual(view.unpriced, [])
})

test('内置价目：不给配置也能给 deepseek-flash 计价', async () => {
	const { definition: def } = await register(undefined)
	let state = def.init({}, 0)
	state = def.apply(state, {
		type: 'assistant/message',
		time: Date.UTC(2026, 8, 10, 12, 0), // 空闲时段
		data: {
			usage: { inputTokens: 1_000_000, cacheReadTokens: 10_000_000, outputTokens: 1_000_000 },
			message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }
		}
	})
	const view = def.wire.viewSchema.parse(def.wire.view(state))
	// 1M×1 + 10M×0.02 + 1M×4 = 1 + 0.2 + 4 = 5.2
	assert.equal(Number(view.cost.toFixed(4)), 5.2)
	assert.equal(view.models[0].rates.offpeak.output, 4)
})

//#region 余额路由

test('余额路由：注册为 /api 下的精确路由，且关掉 balance 后不再注册', async () => {
	const { route } = await register(undefined)
	assert.equal(route.kind, 'exact')
	assert.equal(route.path, BALANCE_PATH)
	assert.equal(typeof route.handler, 'function')

	const disabled = await register({ balance: { enabled: false } })
	assert.equal(disabled.route, undefined)
})

test('余额路由：本机 GET 走完凭据 → 上游 → 响应，并带上低额阈值', async () => {
	const { route } = await register({ balance: { lowThreshold: 20 } })
	const stub = stubFetch(async () => ({ ok: true, json: async () => BALANCE_BODY }))
	try {
		const res = fakeResponse()
		await route.handler(fakeRequest(), res)
		assert.equal(res.captured.status, 200)
		const payload = JSON.parse(res.captured.body)
		assert.equal(payload.ok, true)
		assert.equal(payload.balance.total, 107.54)
		assert.equal(payload.balance.toppedUp, 107.54)
		assert.equal(payload.lowThreshold, 20)
		assert.equal(stub.count(), 1)
	} finally {
		stub.restore()
	}
})

test('余额路由：TTL 缓存命中不重复打上游，?refresh=1 强制穿透', async () => {
	const { route } = await register(undefined)
	const stub = stubFetch(async () => ({ ok: true, json: async () => BALANCE_BODY }))
	try {
		await route.handler(fakeRequest(), fakeResponse())
		await route.handler(fakeRequest(), fakeResponse())
		assert.equal(stub.count(), 1, '第二次应命中 TTL 缓存')

		await route.handler(fakeRequest({ url: BALANCE_PATH + '?refresh=1' }), fakeResponse())
		assert.equal(stub.count(), 2, '?refresh=1 应穿透缓存')
	} finally {
		stub.restore()
	}
})

test('余额路由：没配凭据时给 no-credential，不打上游', async () => {
	const { route } = await register(undefined, { apiKey: '' })
	const stub = stubFetch(async () => ({ ok: true, json: async () => BALANCE_BODY }))
	try {
		const res = fakeResponse()
		await route.handler(fakeRequest(), res)
		const payload = JSON.parse(res.captured.body)
		assert.equal(payload.ok, false)
		assert.equal(payload.error, 'no-credential')
		assert.equal(payload.message, 'DEEPSEEK_API_KEY')
		assert.equal(stub.count(), 0)
	} finally {
		stub.restore()
	}
})

test('余额路由：上游 401 映射成 unauthorized；非本机/非 GET 被围栏挡下', async () => {
	const { route } = await register(undefined)
	const stub = stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }))
	try {
		const res = fakeResponse()
		await route.handler(fakeRequest(), res)
		assert.equal(JSON.parse(res.captured.body).error, 'unauthorized')

		const forbidden = fakeResponse()
		await route.handler(fakeRequest({ socket: { remoteAddress: '10.0.0.9' } }), forbidden)
		assert.equal(forbidden.captured.status, 403)

		const wrongMethod = fakeResponse()
		await route.handler(fakeRequest({ method: 'POST' }), wrongMethod)
		assert.equal(wrongMethod.captured.status, 405)
	} finally {
		stub.restore()
	}
})

//#endregion
