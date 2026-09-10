/**
 * dsh-cost-pill · 宿主半边
 *
 * 两件事：
 *   1. 把「本会话 API 费用」注册成官方会话投影（`ctx.sessionProjections` 的 `costPill`
 *      单元），浏览器半边用插槽运行时给的 `useProjection('costPill')` 读取；
 *   2. 在 web server 上注册一个 **loopback-only** 的余额路由
 *      `/api/cost-pill/balance`，把提供商账户余额（及低额阈值）交给浏览器半边显示。
 *
 * 为什么余额不也走投影：投影的契约是「对已提交事件做同步纯折叠」，不能做 I/O。
 * 账户余额既不是会话日志的推导结果、也不能在折叠里发网络请求，所以它走一条只读的
 * 精确路由；API Key 只在宿主进程内解析与使用，**绝不**回传浏览器。
 *
 * 模型可见面：无。本插件不注入任何提示词、消息、工具或模型调用。
 */

import { DEEPSEEK_DEFAULTS, balanceStatusOf, foreignCallerOf, queryBalance } from './balance.js'
import { DEFAULT_TTL_MS, DEFAULT_TIMEOUT_MS, PRICING_URL, defaultCachePath, loadPricingModels, toPricingTable } from './price-source.js'
import { PRICING_CHECKED_AT, PRICING_SOURCE, applyEvent, initialState, resolvePricing, viewOf } from './pricing.js'

/** 客户端读取用的投影键（浏览器半边必须用同一个字符串）。 */
export const PROJECTION_KEY = 'costPill'

/** 状态结构或折叠语义一变就要 +1；注册表拒绝同键不同版本共享 cell。 */
export const STATE_VERSION = 1

/** 余额路由路径（精确路由，落在 /api 下）。 */
export const BALANCE_PATH = '/api/cost-pill/balance'

export const name = 'dsh-cost-pill'

/** 投影注册表与 web server 都是硬依赖：缺任一都无法提供完整功能。 */
export const inject = ['sessionProjections', 'webServer']

/**
 * 注册表只用到 schema 的 `.parse(value)`（校验检查点与视图）。
 * 优先用官方 schemastery 拿到真实校验；万一它在当前解析根下不可 import
 * （本地 link 安装的插件，其依赖不一定能沿 node_modules 链找到），退化为直通
 * schema，功能不受影响，只是少了校验。
 */
async function loadSchemaFactory() {
	try {
		const mod = await import('@deepseek-ai/schemastery')
		const candidate = mod?.default ?? mod
		if (typeof candidate?.object === 'function') return candidate
	} catch {
		/* 落到直通 schema */
	}
	return undefined
}

/** 直通 schema：只满足注册表的 `.parse()` 契约。 */
function passthroughSchema() {
	return {
		parse: (value) => value,
		toString: () => 'passthrough'
	}
}

function buildSchemas(Schema) {
	if (Schema === undefined) {
		return { stateSchema: passthroughSchema(), viewSchema: passthroughSchema() }
	}
	const Buckets = Schema.object({
		input: Schema.number().default(0),
		cacheRead: Schema.number().default(0),
		cacheWrite: Schema.number().default(0),
		output: Schema.number().default(0)
	})
	const Periods = Schema.object({ peak: Buckets, offpeak: Buckets })
	const stateSchema = Schema.object({
		total: Periods,
		models: Schema.dict(Periods),
		updatedAt: Schema.number().default(0),
		samples: Schema.number().default(0)
	})
	const Rates = Schema.object({
		input: Schema.number(),
		cacheRead: Schema.number(),
		cacheWrite: Schema.number(),
		output: Schema.number()
	})
	const viewSchema = Schema.object({
		cost: Schema.number(),
		peakCost: Schema.number(),
		offpeakCost: Schema.number(),
		unpriced: Schema.array(Schema.string()),
		models: Schema.array(
			Schema.object({
				key: Schema.string(),
				priced: Schema.boolean(),
				cost: Schema.number().default(0),
				peakCost: Schema.number().default(0),
				offpeakCost: Schema.number().default(0),
				rates: Schema.object({ offpeak: Rates, peak: Rates }),
				tokens: Schema.object({
					input: Schema.number(),
					cacheRead: Schema.number(),
					cacheWrite: Schema.number(),
					output: Schema.number(),
					total: Schema.number()
				}),
				cacheHitRate: Schema.union([Schema.number(), Schema.const(null)]),
				peakTokens: Schema.number().default(0),
				offpeakTokens: Schema.number().default(0)
			})
		),
		tokens: Schema.object({
			input: Schema.number(),
			cacheRead: Schema.number(),
			cacheWrite: Schema.number(),
			output: Schema.number(),
			total: Schema.number()
		}),
		cacheHitRate: Schema.union([Schema.number(), Schema.const(null)]),
		updatedAt: Schema.number(),
		samples: Schema.number(),
		// 价目表来源元信息：schemastery 只保留声明过的字段，所以这里必须声明，
		// 否则界面拿不到「这份价目是哪来的、什么时候核对的」。
		pricing: Schema.object({
			source: Schema.string(),
			url: Schema.string(),
			checkedAt: Schema.string(),
			fetchedAt: Schema.union([Schema.number(), Schema.const(null)]),
			error: Schema.union([Schema.string(), Schema.const(null)])
		})
	})
	return { stateSchema, viewSchema }
}

//#region 价目表刷新

/** 在线刷新默认值（可被插件行 config 的 `pricingRefresh` 段覆盖）。 */
const REFRESH_DEFAULTS = {
	enabled: true,
	ttlMs: DEFAULT_TTL_MS,
	timeoutMs: DEFAULT_TIMEOUT_MS
}

/** 归一化 `pricingRefresh` 段。自定义 URL 必须是 https（不允许明文与本地地址）。 */
function resolveRefreshConfig(raw) {
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const number = (value, fallback) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
	return {
		enabled: source.enabled === undefined ? REFRESH_DEFAULTS.enabled : source.enabled === true,
		ttlMs: number(source.ttlMs, REFRESH_DEFAULTS.ttlMs),
		timeoutMs: number(source.timeoutMs, REFRESH_DEFAULTS.timeoutMs),
		url: typeof source.url === 'string' && source.url.startsWith('https://') ? source.url : PRICING_URL,
		cachePath: typeof source.cachePath === 'string' && source.cachePath.length > 0 ? source.cachePath : defaultCachePath()
	}
}

//#endregion

//#region 余额路由

/** 余额配置默认值（可被插件行 config 的 `balance` 段覆盖）。 */
const BALANCE_DEFAULTS = {
	enabled: true,
	cacheMs: 120_000,
	timeoutMs: 15_000,
	lowThreshold: 10
}

/** 归一化插件行 config 里的 `balance` 段。 */
function resolveBalanceConfig(raw) {
	const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const number = (value, fallback) =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
	return {
		enabled: source.enabled === undefined ? BALANCE_DEFAULTS.enabled : source.enabled === true,
		cacheMs: number(source.cacheMs, BALANCE_DEFAULTS.cacheMs),
		timeoutMs: number(source.timeoutMs, BALANCE_DEFAULTS.timeoutMs),
		lowThreshold: number(source.lowThreshold, BALANCE_DEFAULTS.lowThreshold)
	}
}

/** 从 harness settings 的 `llm-deepseek` 命名空间 + credentials 缝解析连接事实。 */
async function deepseekFacts(ctx) {
	const settings = ctx.get('settings')
	const deepseek = settings?.get?.('llm-deepseek')
	const apiKeyEnv =
		typeof deepseek?.apiKeyEnv === 'string' && deepseek.apiKeyEnv.length > 0
			? deepseek.apiKeyEnv
			: DEEPSEEK_DEFAULTS.apiKeyEnv
	const baseURL =
		typeof deepseek?.baseURL === 'string' && deepseek.baseURL.length > 0
			? deepseek.baseURL
			: DEEPSEEK_DEFAULTS.baseURL

	const credentials = ctx.get('credentials')
	let apiKey = ''
	if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
		try {
			const hit = await credentials.resolve(apiKeyEnv)
			apiKey = typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : ''
		} catch {
			apiKey = ''
		}
	}
	return { baseURL, apiKey, apiKeyEnv }
}

function writeJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(JSON.stringify(payload))
}

/**
 * 余额的 TTL 缓存与单飞闸：手动刷新（`?refresh=1`）绕过 TTL，但仍与并发请求合并，
 * 因此连点刷新不会把上游打出一串请求。
 */
function createBalanceSource(ctx, config) {
	let cache = null
	let inflight = null
	let factsCache = null

	const load = async () => {
		// 凭据与 settings 极少变化，缓存 5 分钟，避免每次刷新都过一遍凭据缝。
		if (factsCache === null || Date.now() - factsCache.at > 300_000) {
			factsCache = { facts: await deepseekFacts(ctx), at: Date.now() }
		}
		const { baseURL, apiKey, apiKeyEnv } = factsCache.facts
		if (apiKey === '') {
			return { ok: false, error: 'no-credential', message: apiKeyEnv, fetchedAt: Date.now() }
		}
		try {
			const balance = await queryBalance({ baseURL, apiKey, timeoutMs: config.timeoutMs })
			return { ok: true, balance, fetchedAt: Date.now() }
		} catch (error) {
			return {
				ok: false,
				error: balanceStatusOf(error),
				message: error instanceof Error ? error.message : String(error),
				fetchedAt: Date.now()
			}
		}
	}

	return async (force) => {
		if (!force && cache !== null && Date.now() - cache.fetchedAt < config.cacheMs) return cache
		if (inflight !== null) return inflight
		inflight = load()
			.then((result) => {
				cache = result
				return result
			})
			.finally(() => {
				inflight = null
			})
		return inflight
	}
}

//#endregion

/**
 * 插件主体。
 *
 * @param ctx - 插件上下文；`sessionProjections` 与 `webServer` 由 `inject` 保证存在。
 * @param config - 插件行 config：`pricing` 覆盖价目表（最高优先级），`pricingRefresh` 配置
 *   在线刷新，`balance` 配置余额路由。
 */
export async function apply(ctx, config) {
	const balanceConfig = resolveBalanceConfig(config?.balance)
	const refreshConfig = resolveRefreshConfig(config?.pricingRefresh)
	const Schema = await loadSchemaFactory()
	const { stateSchema, viewSchema } = buildSchemas(Schema)

	/**
	 * 价目表与它的来源元信息放在可变持有器里：在线刷新是**后台**完成的，投影的 view
	 * 每次被调用时读当前值，因此刷新会在下一个计费样本到来时体现（注册表只在事件提交
	 * 时重算 wire.view，没有「主动 poke」的接口 —— 这是投影契约的取舍，见 README）。
	 */
	const holder = {
		pricing: resolvePricing(config?.pricing),
		meta: { source: 'builtin', url: PRICING_SOURCE, checkedAt: PRICING_CHECKED_AT, fetchedAt: null, error: null }
	}

	ctx.sessionProjections.register({
		key: PROJECTION_KEY,
		stateVersion: STATE_VERSION,
		stateSchema,
		init: () => initialState(),
		apply: (state, event) => applyEvent(state, event),
		wire: {
			viewSchema,
			view: (state) => viewOf(state, holder.pricing, holder.meta)
		}
	})

	// 在线刷新：不阻塞注册与渲染，失败只降级来源（见 lib/price-source.js）。
	if (refreshConfig.enabled) {
		void loadPricingModels({
			cachePath: refreshConfig.cachePath,
			ttlMs: refreshConfig.ttlMs,
			timeoutMs: refreshConfig.timeoutMs,
			url: refreshConfig.url
		})
			.then((result) => {
				if (result.models === null) {
					holder.meta = { ...holder.meta, source: 'builtin', error: result.error }
					return
				}
				holder.pricing = resolvePricing(config?.pricing, toPricingTable(result.models))
				holder.meta = {
					source: result.source,
					url: result.url ?? refreshConfig.url,
					checkedAt: PRICING_CHECKED_AT,
					fetchedAt: result.fetchedAt,
					error: result.error
				}
			})
			.catch((error) => {
				holder.meta = { ...holder.meta, error: error instanceof Error ? error.message : String(error) }
			})
	}

	if (!balanceConfig.enabled) return

	const readBalance = createBalanceSource(ctx, balanceConfig)
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: BALANCE_PATH,
				handler: async (req, res) => {
					const refused = foreignCallerOf(req)
					if (refused !== null) {
						writeJson(res, refused.status, { ok: false, error: refused.error })
						return
					}
					const url = new URL(req.url ?? BALANCE_PATH, 'http://localhost')
					const result = await readBalance(url.searchParams.get('refresh') === '1')
					writeJson(res, 200, { ...result, lowThreshold: balanceConfig.lowThreshold })
				}
			}),
		'cost-pill: balance route'
	)
}
