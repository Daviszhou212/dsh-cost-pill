/**
 * 宿主半边单测：用一个假的 ctx 捕获投影定义与余额路由，验证注册契约成立，并让真实
 * 入口 `apply()` 走完「折叠 → 折算」与「路由 → 凭据 → 上游 → 响应」两条全流程。
 *
 * 注意：这里也顺带覆盖「schemastery 不可解析 → 退化为直通 schema」这条路径
 * （本地 link 安装的插件，其依赖不一定能沿 node_modules 链找到）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, BALANCE_PATH, buildSchemas, PROJECTION_KEY, STATE_VERSION, TREE_PATH } from '../lib/index.js'

/**
 * 用假 ctx 跑 apply()。
 *
 * @param config - 插件行 config。
 * @param options - `{ apiKey }`：假凭据缝返回值；`''` 表示没有配 Key。
 *   `{ resolveImpl }`：完全接管 credentials.resolve（用于验证挂起场景）。
 * @returns `{ definition, routeFor, routes }`。
 */
async function register(config, options = {}) {
	const apiKey = options.apiKey === undefined ? 'sk-test' : options.apiKey
	const resolveImpl = options.resolveImpl ?? (async () => ({ value: apiKey }))
	let definition
	const routes = []
	const ctx = {
		sessionProjections: {
			register(def) {
				definition = def
				return () => {}
			}
		},
		webServer: {
			register(row) {
				routes.push(row)
				return () => {}
			}
		},
		effect(fn) {
			return fn()
		},
		get(name) {
			if (name === 'settings') return { get: (ns) => (ns === 'llm-deepseek' ? {} : undefined) }
			if (name === 'credentials') return { resolve: resolveImpl }
			return undefined
		}
	}
	await apply(ctx, config)
	return {
		definition,
		routes,
		routeFor: (path) => routes.find((row) => row.path === path)
	}
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
	const { routeFor } = await register(undefined)
	const route = routeFor(BALANCE_PATH)
	assert.equal(route.kind, 'exact')
	assert.equal(route.path, BALANCE_PATH)
	assert.equal(typeof route.handler, 'function')

	const disabled = await register({ balance: { enabled: false } })
	assert.equal(disabled.routeFor(BALANCE_PATH), undefined, '关闭余额后不应注册路由')
})

test('余额路由：本机 GET 走完凭据 → 上游 → 响应，并带上低额阈值', async () => {
	const { routeFor } = await register({ balance: { lowThreshold: 20 } })
	const route = routeFor(BALANCE_PATH)
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
	const { routeFor } = await register(undefined)
	const route = routeFor(BALANCE_PATH)
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
	const { routeFor } = await register(undefined, { apiKey: '' })
	const route = routeFor(BALANCE_PATH)
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
	const { routeFor } = await register(undefined)
	const route = routeFor(BALANCE_PATH)
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

test('余额路由：resolve 永挂时不再拖死路由（超时后按无凭据降级）', async () => {
	const never = new Promise(() => {})
	const { routeFor } = await register({ balance: { resolveTimeoutMs: 30 } }, { apiKey: undefined, resolveImpl: async () => never })
	const route = routeFor(BALANCE_PATH)
	const stub = stubFetch(async () => ({ ok: true, json: async () => BALANCE_BODY }))
	try {
		const res = fakeResponse()
		await route.handler(fakeRequest(), res)
		assert.equal(res.captured.status, 200)
		assert.equal(JSON.parse(res.captured.body).error, 'no-credential')
		assert.equal(stub.count(), 0)
	} finally {
		stub.restore()
	}
})

test('余额路由：timeoutMs 写 0 被拒之门外，回落默认值且查询仍成功', async () => {
	const { routeFor } = await register({ balance: { timeoutMs: 0 } })
	const route = routeFor(BALANCE_PATH)
	const stub = stubFetch(async () => ({ ok: true, json: async () => BALANCE_BODY }))
	try {
		const res = fakeResponse()
		await route.handler(fakeRequest(), res)
		assert.equal(res.captured.status, 200)
		assert.equal(JSON.parse(res.captured.body).ok, true)
	} finally {
		stub.restore()
	}
})

//#endregion

//#region schema 契约

/**
 * 复刻 schemastery 3.18.2 的形状：`Schema.xxx()` 返回**可调用函数**，
 * 校验靠调用形式（非法抛错），实例上没有 .parse。withParse=true 时刻意提供 .parse
 * 用于对照「已有 .parse 的实例应原样透传」。
 */
function makeFakeSchemastery(options = {}) {
	const make = (validate) => {
		const fn = (value) => validate(value)
		fn.default = (defaultValue) => make((value) => (value === undefined || value === null ? defaultValue : fn(value)))
		if (options.withParse === true) fn.parse = (value) => fn(value)
		return fn
	}
	const number = () => make((value) => {
		if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('expected number')
		return value
	})
	const string = () => make((value) => {
		if (typeof value !== 'string') throw new Error('expected string')
		return value
	})
	const boolean = () => make((value) => {
		if (typeof value !== 'boolean') throw new Error('expected boolean')
		return value
	})
	return {
		object: (shape) => make((value) => {
			if (value === null || typeof value !== 'object') throw new Error('expected object')
			const out = {}
			for (const key of Object.keys(shape)) out[key] = shape[key](value[key])
			return out
		}),
		dict: (entry) => make((value) => {
			if (value === null || typeof value !== 'object') throw new Error('expected dict')
			const out = {}
			for (const key of Object.keys(value)) out[key] = entry(value[key])
			return out
		}),
		array: (entry) => make((value) => {
			if (!Array.isArray(value)) throw new Error('expected array')
			return value.map((item) => entry(item))
		}),
		union: (alternatives) => make((value) => {
			let lastError
			for (const alternative of alternatives) {
				try {
					return alternative(value)
				} catch (error) {
					lastError = error
				}
			}
			throw lastError ?? new Error('no union option matched')
		}),
		const: (constant) => make((value) => {
			if (value !== constant) throw new Error('expected constant ' + String(constant))
			return value
		}),
		number,
		string,
		boolean
	}
}

test('schema 契约：可调用无 .parse 的 schemastery 实例会被包出 .parse（回归：注册表炸 TypeError）', () => {
	const { stateSchema, viewSchema } = buildSchemas(makeFakeSchemastery())
	assert.equal(typeof stateSchema.parse, 'function', 'stateSchema 必须有 .parse（注册表契约）')
	assert.equal(typeof viewSchema.parse, 'function', 'viewSchema 必须有 .parse')

	// 合法值：parse 走调用形式校验并返回结果 —— 真实校验仍然生效
	const state = stateSchema.parse({
		total: { peak: {}, offpeak: {} },
		models: {},
		updatedAt: 1,
		samples: 2
	})
	assert.equal(state.samples, 2)
	// 非法值：调用形式抛错（证明不是被 passthrough 吞掉的）。updatedAt 是 number 字段。
	assert.throws(() => stateSchema.parse({ total: { peak: {}, offpeak: {} }, models: {}, updatedAt: 'x', samples: 2 }), /expected number/)
	assert.throws(() => viewSchema.parse({ cost: 'x' }), /expected/)
})

test('schema 契约：已有 .parse 的实例原样透传，undefined 走直通', () => {
	const built = buildSchemas(makeFakeSchemastery({ withParse: true }))
	assert.equal(typeof built.stateSchema.parse, 'function', '已有 .parse 时应原样透传')
	assert.equal(built.stateSchema.parse({ total: { peak: {}, offpeak: {} }, models: {}, updatedAt: 1, samples: 3 }).samples, 3)

	const fallback = buildSchemas(undefined)
	assert.equal(typeof fallback.stateSchema.parse, 'function')
})

test('树路由：注册为精确路由；缺 session 参数给 400', async () => {
	const { routeFor } = await register({ subagents: true })
	const treeRoute = routeFor(TREE_PATH)
	assert.notEqual(treeRoute, undefined, '应注册树路由')
	assert.equal(treeRoute.path, TREE_PATH)

	const res = fakeResponse()
	await treeRoute.handler(fakeRequest({ url: TREE_PATH }), res)
	assert.equal(res.captured.status, 400, '缺 session 参数应 400')
	assert.equal(JSON.parse(res.captured.body).error, 'missing session')
})

//#endregion

