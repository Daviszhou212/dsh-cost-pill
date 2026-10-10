/**
 * dsh-cost-pill · 智谱 GLM Coding Plan 额度查询（纯逻辑，可单测）
 *
 * 接口：`GET {host}/api/monitor/usage/quota/limit`，`Authorization` 头直接放 API Key
 * （**无 Bearer 前缀**，与官方 glm-plan-usage 插件及 cc-switch 的抓包一致）。
 *
 * 实测响应（2026-10-10，open.bigmodel.cn 个人 Pro 套餐）：
 *   `{ code, msg, success, data: { level: 'pro', limits: [...] } }`
 *   limits 条目：`{ type: 'CREDIT_LIMIT', unit: 3 | 6, number, usage, currentValue,
 *                    remaining, percentage, nextResetTime }`
 *   - `unit: 3` → 5 小时窗口；`unit: 6` → 周窗口（cc-switch 实测同一映射）
 *   - `percentage` = currentValue / usage × 100，**已用**百分比（0–100 整数）
 *   - `usage` = 窗口总额度，`currentValue` = 已用，`remaining` = 剩余
 *   - 官方插件老套餐曾见 `type: 'TOKENS_LIMIT'`（同口径）与 `type: 'TIME_LIMIT'`
 *     （MCP 月度）—— 前者一并收取，后者单独归入 `mcp`。
 */

import { providerError } from './balance.js'

/** 额度接口在站点 origin 下的路径。 */
export const ZAI_QUOTA_PATH_SUFFIX = '/api/monitor/usage/quota/limit'

/** 结构非法错误（providerStatus = 'invalid-response'，与余额解析同口径）。 */
function invalidResponse(message) {
	const error = new Error(message)
	error.providerStatus = 'invalid-response'
	return error
}

/** 从一条 limit 里取窗口视图；缺失字段保持 undefined，界面显示为「—」。 */
function windowOf(item) {
	const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
	return {
		usedPercent: num(item.percentage),
		used: num(item.currentValue),
		limit: num(item.usage),
		remaining: num(item.remaining),
		resetAt: num(item.nextResetTime)
	}
}

/**
 * 解析额度接口返回体。
 *
 * 分类优先级（cc-switch 同款，避免周期末按 reset 时间排序把两桶标反）：
 *   1. `unit` 显式分类：3 → 5h，6 → 周；
 *   2. 兜底启发式：无 `nextResetTime` 的优先归 5h（5h 桶在 0% 等状态可能没有
 *      reset），其余按 reset 升序补进仍空缺的槽位。老套餐只回 1 条时自然只有 5h。
 *
 * @param body - 已 JSON.parse 的返回体。
 * @returns `{ level, fiveHour, weekly, mcp }`，窗口为 `{ usedPercent, used, limit, remaining, resetAt }`。
 * @throws 一条可用 limit 都没有时抛（providerStatus = 'invalid-response'）。
 */
export function parseZaiQuotaBody(body) {
	const data = body !== null && typeof body === 'object' ? (body.data ?? body) : null
	if (data === null || typeof data !== 'object' || Array.isArray(data)) {
		throw invalidResponse('quota response is missing data')
	}
	const limits = Array.isArray(data.limits) ? data.limits : []

	let fiveHour = null
	let weekly = null
	let mcp = null
	const unclassified = []
	for (const item of limits) {
		if (item === null || typeof item !== 'object') continue
		const type = typeof item.type === 'string' ? item.type.toUpperCase() : ''
		if (type === 'TIME_LIMIT') {
			if (mcp === null) mcp = windowOf(item)
			continue
		}
		if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') continue
		if (item.unit === 3) {
			if (fiveHour === null) fiveHour = windowOf(item)
			continue
		}
		if (item.unit === 6) {
			if (weekly === null) weekly = windowOf(item)
			continue
		}
		unclassified.push(windowOf(item))
	}

	unclassified.sort((a, b) => (a.resetAt ?? -1) - (b.resetAt ?? -1))
	for (const entry of unclassified) {
		if (fiveHour === null) fiveHour = entry
		else if (weekly === null) weekly = entry
	}

	if (fiveHour === null && weekly === null) throw invalidResponse('quota response has no usable limits')
	return {
		level: typeof data.level === 'string' && data.level.length > 0 ? data.level : undefined,
		fiveHour,
		weekly,
		mcp: mcp ?? undefined
	}
}

/**
 * 查询智谱 Coding Plan 额度。只发一次 GET，带超时；任何失败都抛错，
 * 由调用方决定怎么降级（错误映射与 balance.js 同一套 providerStatus）。
 *
 * @param options - `{ host, apiKey, timeoutMs?, fetchImpl? }`，host 是站点 origin
 *   （如 `https://open.bigmodel.cn`）。
 */
export async function queryZaiQuota({ host, apiKey, timeoutMs = 15_000, fetchImpl = fetch }) {
	const url = new URL(ZAI_QUOTA_PATH_SUFFIX, host).href
	const response = await fetchImpl(url, {
		headers: { authorization: apiKey, 'content-type': 'application/json', 'accept-language': 'en-US,en' },
		signal: AbortSignal.timeout(timeoutMs)
	})
	if (!response.ok) throw providerError(`quota API returned HTTP ${response.status}`, response.status)
	let body
	try {
		body = await response.json()
	} catch {
		throw providerError('quota API returned invalid JSON')
	}
	return parseZaiQuotaBody(body)
}
