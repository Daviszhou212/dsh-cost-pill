/**
 * dsh-cost-pill · 纯逻辑单测（node --test，零依赖）
 *
 * 覆盖三件容易出错的事：峰谷时段判定（含周末/边界）、路由选价、事件折叠与折算。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
	applyEvent,
	cacheHitRateOf,
	costOfBuckets,
	DEFAULT_PRICING,
	emptyBuckets,
	initialState,
	periodOf,
	PRICING_CHECKED_AT,
	PRICING_SOURCE,
	priceOf,
	resolvePricing,
	viewOf
} from '../lib/pricing.js'

/** 北京墙上时间 → UTC 时间戳（北京 = UTC+8，无夏令时）。 */
function beijing(year, month, day, hour, minute = 0) {
	return Date.UTC(year, month - 1, day, hour - 8, minute)
}

test('峰谷判定：工作日边界', () => {
	// 2026-09-10 是周四
	assert.equal(periodOf(beijing(2026, 9, 10, 8, 59)), 'offpeak')
	assert.equal(periodOf(beijing(2026, 9, 10, 9, 0)), 'peak')
	assert.equal(periodOf(beijing(2026, 9, 10, 11, 59)), 'peak')
	assert.equal(periodOf(beijing(2026, 9, 10, 12, 0)), 'offpeak')
	assert.equal(periodOf(beijing(2026, 9, 10, 13, 59)), 'offpeak')
	assert.equal(periodOf(beijing(2026, 9, 10, 14, 0)), 'peak')
	assert.equal(periodOf(beijing(2026, 9, 10, 17, 59)), 'peak')
	assert.equal(periodOf(beijing(2026, 9, 10, 18, 0)), 'offpeak')
})

test('峰谷判定：周末全天按空闲价（2026-08-23 起官方规则）', () => {
	// 2026-09-12 周六、2026-09-13 周日
	assert.equal(periodOf(beijing(2026, 9, 12, 10, 0)), 'offpeak')
	assert.equal(periodOf(beijing(2026, 9, 12, 15, 0)), 'offpeak')
	assert.equal(periodOf(beijing(2026, 9, 13, 10, 0)), 'offpeak')
	assert.equal(periodOf(beijing(2026, 9, 13, 15, 0)), 'offpeak')
})

test('峰谷判定：非法时间戳退化为空闲价', () => {
	assert.equal(periodOf(undefined), 'offpeak')
	assert.equal(periodOf(NaN), 'offpeak')
	assert.equal(periodOf('nope'), 'offpeak')
})

test('金额：按四个桶分别计价', () => {
	const rates = { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }
	const buckets = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }
	assert.equal(Number(costOfBuckets(buckets, rates).toFixed(4)), 5.02)
	assert.equal(costOfBuckets(emptyBuckets(), rates), 0)
})

test('缓存命中率：读取 /（读取 + 未命中），无输入为 null', () => {
	assert.equal(cacheHitRateOf({ input: 1, cacheRead: 9, cacheWrite: 0, output: 0 }), 0.9)
	assert.equal(cacheHitRateOf(emptyBuckets()), null)
})

test('选价：精确命中、去 provider 前缀、最长前缀、未知模型', () => {
	const table = resolvePricing(undefined)
	assert.equal(priceOf('deepseek-official/deepseek-flash', table).key, 'deepseek-flash')
	assert.equal(priceOf('deepseek-flash', table).key, 'deepseek-flash')
	// 带日期/变体后缀的模型 id 走最长前缀匹配
	assert.equal(priceOf('x/deepseek-v4-flash:0731', table).key, 'deepseek-v4-flash')
	assert.equal(priceOf('x/some-unknown-model', table), null)
})

test('价目覆盖：分时段与不分时段两种写法都能合并', () => {
	const perPeriod = resolvePricing({
		'deepseek-flash': {
			offpeak: { input: 1, cacheRead: 0.02, output: 4 },
			peak: { input: 2, cacheRead: 0.04, output: 8 }
		}
	})
	assert.equal(perPeriod['deepseek-flash'].offpeak.output, 4)
	assert.equal(perPeriod['deepseek-flash'].peak.output, 8)
	// 未给的字段继承默认值（cacheWrite 沿用默认 1）
	assert.equal(perPeriod['deepseek-flash'].offpeak.cacheWrite, 1)

	const flat = resolvePricing({ 'acme/model': { input: 3, output: 6 } })
	assert.deepEqual(flat['acme/model'].peak, flat['acme/model'].offpeak)
	assert.equal(flat['acme/model'].offpeak.cacheRead, 0)
})

test('价目覆盖：在线条目同样过 sanitize，缺省字段继承内置价而不是 0', () => {
	// 官方页/缓存里的原始条目没有 cacheWrite（页面只公布三个桶）——补齐逻辑本该在
	// toPricingTable 完成，但 resolvePricing 对绕过它的调用也不能静默按 0 元计。
	const online = resolvePricing(undefined, {
		'deepseek-flash': {
			offpeak: { input: 1, cacheRead: 0.02, output: 4 },
			peak: { input: 2, cacheRead: 0.04, output: 8 }
		},
		'brand-new-model': { offpeak: { input: 3, cacheRead: 0.06, output: 12 }, peak: { input: 6, cacheRead: 0.12, output: 24 } }
	})
	assert.equal(online['deepseek-flash'].offpeak.cacheWrite, 1, '继承内置 offpeak cacheWrite')
	assert.equal(online['deepseek-flash'].peak.cacheWrite, 2, '继承内置 peak cacheWrite')
	// 内置没有的模型：缺省字段为 0（而不是 undefined 混进金额计算）
	assert.equal(online['brand-new-model'].offpeak.cacheWrite, 0)
	assert.equal(online['brand-new-model'].peak.input, 6)
})

test('折叠：不关心的事件原样返回同一引用（投影注册表的零成本契约）', () => {
	const state = initialState()
	assert.equal(applyEvent(state, { type: 'user/message', data: {} }), state)
	assert.equal(applyEvent(state, { type: 'assistant/message', data: {} }), state)
	assert.equal(applyEvent(state, null), state)
})

test('折叠：按事件时间归属时段、按 provider/model 归因', () => {
	let state = initialState()
	const event = (time, usage) => ({
		type: 'assistant/message',
		time,
		data: { usage, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } } }
	})

	state = applyEvent(state, event(beijing(2026, 9, 10, 10, 0), { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 }))
	state = applyEvent(state, event(beijing(2026, 9, 10, 20, 0), { inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 1000 }))

	assert.equal(state.samples, 2)
	assert.equal(state.total.peak.input, 1000)
	assert.equal(state.total.offpeak.input, 2000)
	assert.equal(state.total.peak.cacheRead, 9000)
	assert.equal(state.total.offpeak.output, 1000)

	// 无 source 的样本落到 unknown/unknown，不污染真实路由
	state = applyEvent(state, { type: 'assistant/message', time: beijing(2026, 9, 10, 20, 0), data: { usage: { inputTokens: 1 } } })
	assert.ok(state.models['unknown/unknown'] !== undefined)
})

test('折叠：全 0 / 数组形式的 usage 不制造幽灵样本（评审发现）', () => {
	let state = initialState()
	const base = { message: { source: { provider: 'x', model: 'y' } } }
	state = applyEvent(state, {
		type: 'assistant/message',
		time: beijing(2026, 9, 10, 10, 0),
		data: { usage: [], message: base }
	})
	state = applyEvent(state, {
		type: 'assistant/message',
		time: beijing(2026, 9, 10, 10, 0),
		data: { usage: {}, message: base }
	})
	state = applyEvent(state, {
		type: 'assistant/message',
		time: beijing(2026, 9, 10, 10, 0),
		data: { usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, message: base }
	})
	assert.equal(state.samples, 0, '无效样本不应虚增计数')
	assert.deepEqual(Object.keys(state.models), [], '不应制造幽灵模型条目')
})

test('覆盖：全新模型只配单时段，另一时段镜像而不是归零（评审发现）', () => {
	// 回归：新模型没有基座可继承，缺失时段曾兜底成全 0 —— 高峰用量被静默按 0 元计
	const pricing = resolvePricing({ 'relay/mymodel': { offpeak: { input: 1, cacheRead: 0.02, output: 4 } } })
	assert.equal(pricing['relay/mymodel'].peak.input, 1)
	assert.equal(pricing['relay/mymodel'].peak.cacheRead, 0.02)
	assert.equal(pricing['relay/mymodel'].peak.output, 4)

	// 只给 peak 时对称成立
	const mirrorPeak = resolvePricing({ 'relay/other': { peak: { input: 2, output: 8 } } })
	assert.equal(mirrorPeak['relay/other'].offpeak.input, 2)
	assert.equal(mirrorPeak['relay/other'].offpeak.output, 8)
})

test('折算：视图给出总额、分时段、分模型与命中率', () => {
	let state = initialState()
	state = applyEvent(state, {
		type: 'assistant/message',
		time: beijing(2026, 9, 10, 10, 0),
		data: {
			usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
			message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }
		}
	})
	state = applyEvent(state, {
		type: 'assistant/message',
		time: beijing(2026, 9, 10, 20, 0),
		data: {
			usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 },
			message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }
		}
	})

	const view = viewOf(state, resolvePricing(undefined))
	// 高峰 1M 未命中 = ¥2；空闲 1M 未命中 = ¥1
	assert.equal(Number(view.peakCost.toFixed(4)), 2)
	assert.equal(Number(view.offpeakCost.toFixed(4)), 1)
	assert.equal(Number(view.cost.toFixed(4)), 3)
	assert.equal(view.tokens.input, 2_000_000)
	assert.equal(view.tokens.total, 2_000_000)
	assert.equal(view.models.length, 1)
	assert.equal(view.unpriced.length, 0)
})

test('折算：未知模型不计金额但列进 unpriced', () => {
	let state = initialState()
	state = applyEvent(state, {
		type: 'assistant/message',
		time: beijing(2026, 9, 10, 20, 0),
		data: {
			usage: { inputTokens: 1_000_000 },
			message: { source: { provider: 'acme', model: 'mystery-1' } }
		}
	})
	const view = viewOf(state, resolvePricing(undefined))
	assert.equal(view.cost, 0)
	assert.deepEqual(view.unpriced, ['acme/mystery-1'])
	assert.equal(view.models[0].priced, false)
})

/**
 * 价格门禁：内置价目必须逐项等于官方定价页上的数字。
 * 这是「防虚构」护栏 —— 有人改价时必须同时改这里，并核对 PRICING_SOURCE 页面。
 * DeepSeek 官方页（2026-09-20 复核，与 09-10 一致）：flash 命中 0.02 / 未命中 1 /
 * 输出 4（空闲），高峰 ×2；v4-pro 命中 0.15 / 未命中 4.5 / 输出 13.5（空闲），高峰 ×2。
 * GLM-5.3-Flash（bigmodel.cn，2026-09-20）：标准价 输入 0.8 / 缓存命中 0.23 / 输出 2.8，不分峰谷。
 */
test('价格门禁：内置价目与官方页面逐项一致', () => {
	const flash = { offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }, peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 } }
	const pro = { offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 }, peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 } }
	const glm = { offpeak: { input: 0.8, cacheRead: 0.23, cacheWrite: 0.8, output: 2.8 }, peak: { input: 0.8, cacheRead: 0.23, cacheWrite: 0.8, output: 2.8 } }

	assert.deepEqual(DEFAULT_PRICING['deepseek-flash'], flash)
	assert.deepEqual(DEFAULT_PRICING['deepseek-v4-flash'], flash, '旧模型名按 Flash 价计费（页面脚注 1）')
	assert.deepEqual(DEFAULT_PRICING['deepseek-v4-flash-vision-exp'], flash, '同上')
	assert.deepEqual(DEFAULT_PRICING['deepseek-v4-pro'], pro)
	assert.deepEqual(DEFAULT_PRICING['glm-5.3-flash'], glm)
	assert.equal(PRICING_CHECKED_AT, '2026-09-20')
	assert.match(PRICING_SOURCE, /api-docs\.deepseek\.com\/zh-cn\/quick_start\/pricing/)
})

test('选价：zai-coding-cn 的 glm 路由命中 glm-5.3-flash 条目', () => {
	const table = resolvePricing(undefined)
	assert.equal(priceOf('zai-coding-cn/glm-5.3-flash', table).key, 'glm-5.3-flash')
})

test('价格门禁：flash 系高峰恰为空闲的两倍（页面脚注 3）', () => {
	for (const key of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
		const entry = DEFAULT_PRICING[key]
		for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output']) {
			assert.equal(entry.peak[bucket], entry.offpeak[bucket] * 2, `${key}.${bucket} 高峰应为空闲的两倍`)
		}
	}
})
