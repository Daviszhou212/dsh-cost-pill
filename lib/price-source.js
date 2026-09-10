/**
 * dsh-cost-pill · 价目表的在线来源（抓取 + 校验 + 缓存 + 兜底）
 *
 * 为什么不"每次启动直接抓了就用"：裸抓一张网页当计价依据，比内置一张写死的表更危险
 * —— 页面改版、抓错数字、断网、公司代理，任何一种都会让用户看到**错的钱**，而且错得
 * 没有痕迹。所以这里把在线来源做成一条有闸门的链路：
 *
 *   1. **只抓一个白名单 URL**（官方中文定价页），HTTPS，超时，单个请求；
 *   2. **严格解析**：先定位含「缓存命中」的表格，再按表头把「模型列」映射成模型 id，
 *      只认「百万tokens输入（缓存命中/未命中）」「百万tokens输出」三类行；
 *   3. **多重校验**：高峰必须恰为空闲的两倍（官方脚注 3 的不变式）、桶之间的大小关系
 *      合理、必须至少解析出一个 flash 系模型 —— 任何一条不过就**整表丢弃**，
 *      继续用上一份好数据；
 *   4. **磁盘缓存 + TTL**：抓到就落盘，之后启动先读缓存；缓存过期才再抓。断网时
 *      仍能用上次的好数据，而不是回退到写死的旧价；
 *   5. **绝不阻塞**：抓取发生在后台，投影注册与界面渲染不等待网络；任何失败都只降级
 *      数据来源并留下原因，不影响费用显示。
 *
 * 优先级：用户的 `pricing` 配置 > 在线/缓存价目 > 内置价目（见 lib/index.js）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 价目表来源页（中文页，单位为元）。 */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** 缓存默认存活时间：24 小时。 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** 抓取默认超时：15 秒。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 三类计费桶在页面上的行标签 → 内部桶名。 */
const BUCKETS = [
	{ name: 'cacheRead', test: /缓存命中/ },
	{ name: 'input', test: /缓存未命中/ },
	{ name: 'output', test: /百万\s*tokens\s*输出/ }
]

/** 去掉单元格里的标签与脚注标记，例如 `deepseek-flash(1)` → `deepseek-flash`。 */
function cleanCell(html) {
	return String(html)
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/** 从一个 `<table>` 块里取出所有行、每行取出单元格文本。 */
function rowsOf(tableHtml) {
	return [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((row) =>
		[...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => cleanCell(cell[1]))
	)
}

/** `0.02元` / `1元` / `13.5 元` → 数字；解析不出返回 undefined。 */
function amountOf(cell) {
	const match = /(\d+(?:\.\d+)?)/.exec(String(cell))
	return match === null ? undefined : Number(match[1])
}

/**
 * 解析官方定价页 HTML，取出价格表。
 *
 * 只认结构、不认文案顺序：先找含「缓存命中」的表格，从表头行读出模型列，
 * 再按「桶标签行 + 时段行」两段式赋值（页面用 rowspan 让第二个时段行少一个单元格，
 * 所以每行都取**最后 N 个**单元格作为各模型的值）。
 *
 * @param html - 页面 HTML。
 * @returns `{ models, source, note }`；解析不出必需结构时抛错。
 */
export function parsePricingPage(html) {
	const table = [...String(html).matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]).find((t) => t.includes('缓存命中'))
	if (table === undefined) throw new Error('pricing page: no table containing 缓存命中')

	const rows = rowsOf(table)
	const header = rows.find((cells) => cells[0] === '模型' || cells[0] === 'Model')
	if (header === undefined) throw new Error('pricing page: no model header row')

	const models = header
		.slice(1)
		.map((cell) => cell.replace(/\(\d+\)/g, '').replace(/\s+/g, ''))
		.filter((name) => name !== '')
	if (models.length === 0) throw new Error('pricing page: header lists no models')

	const table2 = {}
	for (const name of models) table2[name] = { offpeak: {}, peak: {} }

	let bucket = null
	for (const cells of rows) {
		if (cells.length === 0) continue
		if (cells.some((cell) => /并发限制/.test(cell))) {
			bucket = null
			continue
		}

		// 桶标签不一定在第一格：价格首个数据行的首列被「价格 (n)」占着，桶名在第二格。
		// 所以整行找桶标签，再在其之后（或整行）找时段格。
		const bucketIndex = cells.findIndex((cell) => BUCKETS.some((entry) => entry.test.test(cell)))
		if (bucketIndex !== -1) bucket = BUCKETS.find((entry) => entry.test.test(cells[bucketIndex])).name
		if (bucket === null) continue

		const periodIndex = cells.findIndex((cell, index) => index > bucketIndex && /空闲时段|高峰时段/.test(cell))
		if (periodIndex === -1) continue
		const period = /空闲时段/.test(cells[periodIndex]) ? 'offpeak' : 'peak'

		const values = cells.slice(-models.length)
		if (values.length !== models.length) continue
		models.forEach((name, index) => {
			const amount = amountOf(values[index])
			if (amount !== undefined) table2[name][period][bucket] = amount
		})
	}

	return { models: table2, source: PRICING_URL }
}

/**
 * 校验一张抓来的价目表。返回问题列表（空数组 = 通过）。
 *
 * 最有力的一条是官方脚注 3 的不变式：**高峰必须恰为空闲的两倍**。它能把"抓串行了"
 * 这类错误几乎全部拦下——比如把并发限制的 2500 当成价格、或把两个模型的列错位。
 *
 * @param models - `parsePricingPage` 的结果。
 */
export function validatePricingTable(models) {
	const problems = []
	if (models === null || typeof models !== 'object') return ['table is not an object']

	const names = Object.keys(models)
	if (names.length === 0) problems.push('table has no models')
	if (!names.some((name) => name.includes('flash'))) problems.push('no flash-family model in table')

	for (const name of names) {
		const entry = models[name]
		// 页面只公布三个桶（命中 / 未命中 / 输出）；cacheWrite 由 toPricingTable 按未命中
		// 输入价补齐，所以这里对它是「有则校验、无则不要求」。
		for (const bucket of ['input', 'cacheRead', 'output', 'cacheWrite']) {
			for (const period of ['offpeak', 'peak']) {
				const value = entry?.[period]?.[bucket]
				if (value === undefined) {
					if (bucket !== 'cacheWrite') problems.push(`${name}.${period}.${bucket} missing`)
					continue
				}
				if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
					problems.push(`${name}.${period}.${bucket} non-positive`)
				} else if (value > 1000) {
					problems.push(`${name}.${period}.${bucket} implausible (${value})`)
				}
			}
		}
		const offpeak = entry?.offpeak
		const peak = entry?.peak
		if (offpeak !== undefined && peak !== undefined) {
			for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output']) {
				if (typeof offpeak[bucket] === 'number' && typeof peak[bucket] === 'number' && peak[bucket] !== offpeak[bucket] * 2) {
					problems.push(`${name}.${bucket} peak (${peak[bucket]}) is not twice off-peak (${offpeak[bucket]})`)
				}
			}
			if (typeof offpeak.cacheRead === 'number' && typeof offpeak.input === 'number' && offpeak.cacheRead >= offpeak.input) {
				problems.push(`${name}: cache-hit price is not below cache-miss price`)
			}
		}
	}
	return problems
}

/** 把页面价目补全成内部价目表形态（补 cacheWrite = 未命中输入价）。 */
export function toPricingTable(models) {
	const table = {}
	for (const [name, entry] of Object.entries(models)) {
		table[name] = {
			offpeak: { ...entry.offpeak, cacheWrite: entry.offpeak.cacheWrite ?? entry.offpeak.input },
			peak: { ...entry.peak, cacheWrite: entry.peak.cacheWrite ?? entry.peak.input }
		}
	}
	return table
}

/** 缓存文件路径：`$DSH_HOME/storages/dsh-cost-pill-pricing.json`。 */
export function defaultCachePath() {
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'storages', 'dsh-cost-pill-pricing.json')
}

/** 读缓存；不存在/损坏/过期都返回 null。 */
export function readPricingCache(cachePath, ttlMs, now = Date.now()) {
	try {
		const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
		if (typeof parsed?.fetchedAt !== 'number' || now - parsed.fetchedAt > ttlMs) return null
		if (validatePricingTable(parsed.models).length > 0) return null
		return { models: parsed.models, fetchedAt: parsed.fetchedAt, url: parsed.url ?? PRICING_URL }
	} catch {
		return null
	}
}

/** 写缓存（失败不抛：缓存只是优化）。 */
export function writePricingCache(cachePath, payload) {
	try {
		mkdirSync(dirname(cachePath), { recursive: true })
		writeFileSync(cachePath, JSON.stringify(payload, null, '\t'), 'utf8')
		return true
	} catch {
		return false
	}
}

/** 抓一次页面（单个请求，带超时与最小化的请求头）。 */
export async function fetchPricingPage({ url = PRICING_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
	const response = await fetchImpl(url, {
		headers: { accept: 'text/html', 'user-agent': 'dsh-cost-pill (price refresh)' },
		signal: AbortSignal.timeout(timeoutMs)
	})
	if (!response.ok) throw new Error(`pricing page returned HTTP ${response.status}`)
	return response.text()
}

/**
 * 取得价目表：缓存优先，过期则抓取并校验；任何失败都只降级、不抛。
 *
 * @param options - `{ cachePath, ttlMs, url, timeoutMs, now, fetchImpl }`。
 * @returns `{ models, source, fetchedAt, error }`，`models` 为 null 表示没拿到可用数据。
 */
export async function loadPricingModels(options = {}) {
	const cachePath = options.cachePath ?? defaultCachePath()
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	const now = options.now ?? Date.now()

	const cached = readPricingCache(cachePath, ttlMs, now)
	if (cached !== null) {
		return { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt, error: null }
	}

	try {
		const html = await fetchPricingPage({ url: options.url ?? PRICING_URL, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, fetchImpl: options.fetchImpl })
		const parsed = parsePricingPage(html)
		const problems = validatePricingTable(parsed.models)
		if (problems.length > 0) {
			return { models: null, source: 'rejected', fetchedAt: now, error: problems.join('; ') }
		}
		const payload = { fetchedAt: now, url: options.url ?? PRICING_URL, models: parsed.models }
		writePricingCache(cachePath, payload)
		return { models: parsed.models, source: 'fetched', fetchedAt: now, error: null }
	} catch (error) {
		// 过期缓存也比没有好：拿它兜底，同时把失败原因留给界面
		const stale = readPricingCache(cachePath, Number.POSITIVE_INFINITY, now)
		return {
			models: stale === null ? null : stale.models,
			source: stale === null ? 'unavailable' : 'stale-cache',
			fetchedAt: stale === null ? now : stale.fetchedAt,
			error: error instanceof Error ? error.message : String(error)
		}
	}
}
