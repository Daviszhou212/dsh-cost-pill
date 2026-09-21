/**
 * dsh-cost-pill · 纯计价逻辑
 *
 * 这一层刻意不 import 任何东西：它既被宿主半边（lib/index.js）使用，也能在
 * harness 之外直接被 `node --test` 单测。所有函数都是纯函数，不读时钟、不读全局。
 *
 * 数据口径：只认 provider 在 `assistant/message` 事件里上报的 usage 样本
 * （字段与 harness 的 TokenUsage 同名：input / cacheRead / cacheWrite / output）。
 * 流式 `assistant/chunk` 的 usage 是同一 次尝试的中间快照，计入会与最终样本重复
 * 计费，因此这里**只**取最终样本 —— 代价是费用在每个模型调用完成时更新，而不是
 * 逐 token 跳动。
 */

/** 一个用量桶组；字段名与 provider 上报的 usage 对齐。 */
export function emptyBuckets() {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** 两个桶组相加，返回新对象。 */
export function addBuckets(a, b) {
	return {
		input: (a.input ?? 0) + (b.input ?? 0),
		cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
		cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
		output: (a.output ?? 0) + (b.output ?? 0)
	}
}

/** 桶组求和的 token 总量。 */
export function totalOf(buckets) {
	return (buckets.input ?? 0) + (buckets.cacheRead ?? 0) + (buckets.cacheWrite ?? 0) + (buckets.output ?? 0)
}

/**
 * 北京时间的固定偏移（分钟）。中国大陆自 1991 年起不实行夏令时，因此这里是常量，
 * 不需要 IANA 时区库。
 */
export const BEIJING_OFFSET_MINUTES = 480

/**
 * 官方峰谷时段判定。
 *
 * 官方规则（V4 起）：高峰 = 北京时间工作日 09:00-12:00 与 14:00-18:00；自
 * 2026-08-23 00:00 起周末（周六、周日）全天不再区分峰谷，统一按空闲价计费。
 * 时间戳缺失或非法时按空闲价（更保守，不会凭空放大金额）。
 *
 * @param timeMs - 事件时间戳（epoch 毫秒），取自会话事件的顶层 `time` 字段。
 * @returns `'peak'` 或 `'offpeak'`。
 */
export function periodOf(timeMs) {
	const t = Number(timeMs)
	if (!Number.isFinite(t)) return 'offpeak'
	// 用 UTC getter 读“北京墙上时间”：先整体平移偏移量，再按 UTC 取值。
	const shifted = new Date(t + BEIJING_OFFSET_MINUTES * 60_000)
	const day = shifted.getUTCDay() // 0 = 周日，6 = 周六
	if (day === 0 || day === 6) return 'offpeak'
	const hour = shifted.getUTCHours()
	return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'offpeak'
}

/** 价目表的核对日期（最近一次逐项核对各官方定价页的日期）。 */
export const PRICING_CHECKED_AT = '2026-09-20'

/** 价目表出处：官方中文定价页。 */
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/**
 * 默认价目表：元 / 百万 token，`cacheWrite` 官方无独立价，按未命中输入价计。
 *
 * 逐条核对自官方定价页（{@link PRICING_SOURCE}），核对于
 * {@link PRICING_CHECKED_AT}。页面原文：
 *
 * | 模型 | 缓存命中 空闲/高峰 | 缓存未命中 空闲/高峰 | 输出 空闲/高峰 |
 * | --- | --- | --- | --- |
 * | deepseek-flash | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
 * | deepseek-v4-pro | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |
 *
 * 页面脚注（决定了本表的两条处理）：
 *   (1) 模型名请用 `deepseek-flash`；旧名 `deepseek-v4-flash` /
 *       `deepseek-v4-flash-vision-exp` 已下线，请求由 V4.1-Flash 提供服务并按 Flash
 *       价格计费 —— 所以这两个旧名保留同价条目，老会话日志仍能被正确计价。
 *   (2) `deepseek-v4-pro` 计划下线：2026-09-14 12:00（北京时间）起其请求全部路由到
 *       V4.1 Flash 并按 Flash 价格计费 —— 该日之后本表应把 pro 条目改为 Flash 价或删除。
 *   (3) 空闲价为高峰价的一半；高峰 = 北京时间周一至周五 09:00-12:00、14:00-18:00
 *       （其余为空闲），与 {@link periodOf} 的实现一致。
 *   (4) `glm-5.3-flash` 来自智谱 bigmodel.cn 定价页（2026-09-20 核对）：标准价
 *       输入 0.8 / 缓存命中 0.23 / 输出 2.8 元/M，GLM 不分峰谷（两时段同价）。
 *       页面上的「限时五折」（0.4/0.115/1.4）已于 2026-09 初到期，不采用。注意
 *       zai-coding-cn 的 GLM Coding 套餐是包月制，额度内边际成本为 0 —— 这里的
 *       数字是「按 API 价折算」的等效估算，不是套餐扣费。
 *
 * 历史会话会按**当前**价目重算：本插件不做跨调价的历史分段（见 README「已知限制」）。
 */
export const DEFAULT_PRICING = {
	'deepseek-flash': {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	'deepseek-v4-flash': {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	'deepseek-v4-flash-vision-exp': {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	'deepseek-v4-pro': {
		offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
		peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }
	},
	'glm-5.3-flash': {
		offpeak: { input: 0.8, cacheRead: 0.23, cacheWrite: 0.8, output: 2.8 },
		peak: { input: 0.8, cacheRead: 0.23, cacheWrite: 0.8, output: 2.8 }
	}
}

const RATE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output']

/** 把一个价格行规整成四个非负数字；缺省字段继承 `base`。 */
function sanitizeRates(entry, base) {
	const fallback = base ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
	const out = {}
	for (const key of RATE_KEYS) {
		const value = entry?.[key]
		out[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : (fallback[key] ?? 0)
	}
	return out
}

/**
 * 把插件配置里的 `pricing` 宽松合并到默认价目表之上。
 *
 * 支持两种写法：
 *   - 分时段：`{ offpeak: {...}, peak: {...} }`（未给的字段继承默认值）
 *   - 不分时段：`{ input, output, cacheRead?, cacheWrite? }`（各时段同价）
 *
 * 三层优先级：**内置价目 < 在线/缓存抓到的官方页价目 < 用户的 `pricing` 配置**。
 * 在线价目按模型 id 覆盖内置项；页面没列到的模型（例如已下线的旧名）保留内置价，
 * 这样老会话日志不会因为官方页删了一行就变成「价格未知」。
 *
 * @param overrides - 插件行 config 的 `pricing` 字段。
 * @param onlineModels - 从官方定价页抓到的价目（可选）；缺省时只用内置价目。
 * @returns 新的价目表（不修改任何入参）。
 */
export function resolvePricing(overrides, onlineModels) {
	const seed = onlineModels === null || onlineModels === undefined ? DEFAULT_PRICING : { ...DEFAULT_PRICING, ...onlineModels }
	const merged = {}
	for (const [key, value] of Object.entries(seed)) {
		// 在线条目也过一遍 sanitizeRates：官方页没有 cacheWrite 价，缺省字段继承内置价
		// （cacheWrite 按未命中输入价计），而不是静默变成 0 —— 那会让带 cacheWrite 的
		// 用量在该时段被白送。
		const base = DEFAULT_PRICING[key]
		merged[key] = {
			offpeak: sanitizeRates(value.offpeak ?? value, base?.offpeak ?? base),
			peak: sanitizeRates(value.peak ?? value.offpeak ?? value, base?.peak ?? base?.offpeak ?? base)
		}
	}
	if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return merged
	for (const [key, entry] of Object.entries(overrides)) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
		const base = merged[key]
		const baseOffpeak = base?.offpeak ?? base ?? null
		const basePeak = base?.peak ?? baseOffpeak
		const offpeakGiven = entry.offpeak !== null && typeof entry.offpeak === 'object' && !Array.isArray(entry.offpeak)
		const peakGiven = entry.peak !== null && typeof entry.peak === 'object' && !Array.isArray(entry.peak)
		if (offpeakGiven || peakGiven) {
			// 分时段写法：只给一个时段也成立 —— 已有模型继承基座；**全新模型（无基座）则用
			// 已给的时段补齐另一个**。绝不能让缺失时段兜底成全 0：那会让该时段的用量被
			// 静默按 0 元计，而且 unpriced 为空，看起来就像定价成功了。
			const offpeakSource = offpeakGiven ? entry.offpeak : baseOffpeak ?? entry.peak
			const peakSource = peakGiven ? entry.peak : basePeak ?? entry.offpeak
			merged[key] = {
				offpeak: sanitizeRates(offpeakSource, baseOffpeak),
				peak: sanitizeRates(peakSource, basePeak)
			}
		} else {
			const flat = sanitizeRates(entry, baseOffpeak)
			merged[key] = { offpeak: flat, peak: { ...flat } }
		}
	}
	return merged
}

/**
 * 为一个 `provider/model` 路由选价。匹配顺序（都对大小写不敏感）：
 *   1. 完整路由精确匹配 —— 让「同一模型走官方」与「走中转」可以分别定价；
 *   2. 模型 id（第一个 `/` 之后的部分）精确匹配；
 *   3. 以上两种基座各自的最长前缀匹配，取更长的键 —— 这样带日期/变体后缀的
 *      `deepseek-v4-flash:0731` 也能落到 `deepseek-v4-flash`。
 *
 * @returns `{ key, rates }`，或 `null` 表示价目表里没有这个模型（界面会标为「价格未知」）。
 */
export function priceOf(modelKey, pricing) {
	if (typeof modelKey !== 'string') return null
	const table = pricing ?? DEFAULT_PRICING
	const full = modelKey.toLowerCase()
	const slash = modelKey.indexOf('/')
	const modelId = (slash === -1 ? modelKey : modelKey.slice(slash + 1)).toLowerCase()

	if (table[full] !== undefined) return { key: full, rates: table[full] }
	if (table[modelId] !== undefined) return { key: modelId, rates: table[modelId] }

	let best = null
	for (const key of Object.keys(table)) {
		const lower = key.toLowerCase()
		if (!modelId.startsWith(lower) && !full.startsWith(lower)) continue
		if (best === null || key.length > best.length) best = key
	}
	return best === null ? null : { key: best, rates: table[best] }
}

/** 一组桶在某个时段费率下的金额（元）。 */
export function costOfBuckets(buckets, rates) {
	return (
		(buckets.input ?? 0) * (rates.input ?? 0) +
		(buckets.cacheRead ?? 0) * (rates.cacheRead ?? 0) +
		(buckets.cacheWrite ?? 0) * (rates.cacheWrite ?? 0) +
		(buckets.output ?? 0) * (rates.output ?? 0)
	) / 1e6
}

/** 缓存命中率 = 缓存读取 / (缓存读取 + 未命中输入)；没有输入时为 null。 */
export function cacheHitRateOf(buckets) {
	const read = buckets.cacheRead ?? 0
	const miss = buckets.input ?? 0
	const denom = read + miss
	return denom === 0 ? null : read / denom
}

/** 折叠的初始状态。 */
export function initialState() {
	return {
		total: { peak: emptyBuckets(), offpeak: emptyBuckets() },
		models: {},
		updatedAt: 0,
		samples: 0
	}
}

/** 从 `assistant/message` 事件里取出 provider 上报的用量桶；没有则返回 null。 */
function sampleOf(event) {
	const usage = event?.data?.usage
	if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null
	const sample = {
		input: num(usage.inputTokens ?? usage.input),
		cacheRead: num(usage.cacheReadTokens ?? usage.cacheRead),
		cacheWrite: num(usage.cacheWriteTokens ?? usage.cacheWrite),
		output: num(usage.outputTokens ?? usage.output)
	}
	// 全 0 样本没有计费意义（多半是异常返回体），丢弃 —— 否则会制造 unknown/unknown
	// 的幽灵模型条目并虚增样本计数。
	const total = sample.input + sample.cacheRead + sample.cacheWrite + sample.output
	return total === 0 ? null : sample
}

function num(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 事件的 `provider/model` 归因键。 */
function modelKeyOf(event) {
	const source = event?.data?.message?.source
	if (source !== undefined && typeof source.model === 'string' && source.model.length > 0) {
		const provider = typeof source.provider === 'string' && source.provider.length > 0 ? source.provider : 'unknown'
		return `${provider}/${source.model}`
	}
	return 'unknown/unknown'
}

/**
 * 纯折叠：把一条会话事件并入状态。不关心的事件**原样返回同一引用**，这样
 * 投影注册表可以零成本跳过（契约要求）。
 *
 * 只认 `assistant/message`：它每个模型调用出现一次（重试算作另一次计费尝试，
 * 因此各自计入是正确的）；流式 usage 快照被刻意忽略，避免重复计费。
 *
 * @param state - 当前状态。
 * @param event - 已提交的会话事件。
 * @returns 新状态，或原状态引用。
 */
export function applyEvent(state, event) {
	if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return state
	const sample = sampleOf(event)
	if (sample === null) return state
	const period = periodOf(event.time)
	const key = modelKeyOf(event)

	const total = {
		peak: period === 'peak' ? addBuckets(state.total.peak, sample) : state.total.peak,
		offpeak: period === 'offpeak' ? addBuckets(state.total.offpeak, sample) : state.total.offpeak
	}
	const previous = state.models[key] ?? { peak: emptyBuckets(), offpeak: emptyBuckets() }
	const models = {
		...state.models,
		[key]: {
			peak: period === 'peak' ? addBuckets(previous.peak, sample) : previous.peak,
			offpeak: period === 'offpeak' ? addBuckets(previous.offpeak, sample) : previous.offpeak
		}
	}
	return {
		total,
		models,
		updatedAt: Number.isFinite(Number(event.time)) ? Number(event.time) : state.updatedAt,
		samples: (state.samples ?? 0) + 1
	}
}

/**
 * 把折叠状态折算成一份客户端视图（纯 JSON）。
 *
 * @param state - 折叠状态。
 * @param pricing - 价目表。
 * @param meta - 价目表来源元信息（可选）：`{ source, url, checkedAt, fetchedAt, error }`，
 *   界面据此告诉用户「这个数字是按哪份价目算的、什么时候核对的」。省略时视图不带该字段。
 * @returns 视图对象。
 */
export function viewOf(state, pricing, meta) {
	const total = state?.total ?? { peak: emptyBuckets(), offpeak: emptyBuckets() }
	const models = []
	const unpriced = []
	let cost = 0
	let peakCost = 0
	let offpeakCost = 0

	for (const [key, buckets] of Object.entries(state?.models ?? {})) {
		const found = priceOf(key, pricing)
		if (found === null) {
			unpriced.push(key)
			models.push({ key, cost: 0, priced: false, tokens: tokensOf(buckets), cacheHitRate: cacheHitRateOf(mergeBuckets(buckets)) })
			continue
		}
		const peak = costOfBuckets(buckets.peak, found.rates.peak)
		const offpeak = costOfBuckets(buckets.offpeak, found.rates.offpeak)
		peakCost += peak
		offpeakCost += offpeak
		cost += peak + offpeak
		models.push({
			key,
			priced: true,
			cost: peak + offpeak,
			peakCost: peak,
			offpeakCost: offpeak,
			rates: found.rates,
			tokens: tokensOf(buckets),
			cacheHitRate: cacheHitRateOf(mergeBuckets(buckets)),
			peakTokens: totalOf(buckets.peak),
			offpeakTokens: totalOf(buckets.offpeak)
		})
	}
	models.sort((a, b) => b.cost - a.cost)

	const all = mergeBuckets(total)
	return {
		cost,
		peakCost,
		offpeakCost,
		unpriced,
		models,
		tokens: tokensOf(total),
		cacheHitRate: cacheHitRateOf(all),
		updatedAt: state?.updatedAt ?? 0,
		samples: state?.samples ?? 0,
		...(meta === null || meta === undefined ? {} : { pricing: meta })
	}
}

function mergeBuckets(periodBuckets) {
	return addBuckets(periodBuckets?.peak ?? emptyBuckets(), periodBuckets?.offpeak ?? emptyBuckets())
}

function tokensOf(periodBuckets) {
	const merged = mergeBuckets(periodBuckets)
	return { ...merged, total: totalOf(merged) }
}
