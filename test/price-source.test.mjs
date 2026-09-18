/**
 * 价目表在线来源单测：解析（对真实页面夹具）、校验、缓存、降级。
 *
 * 夹具 `test/fixtures/pricing-page-table.html` 是官方定价页里那张表的**原样摘录**
 * （抓取时间见文件头注释）。解析器对着真实结构写、也对着真实结构测 —— 页面改版时
 * 这里会先红，而不是让用户先看到错的钱。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	DEFAULT_TTL_MS,
	PRICING_URL,
	loadPricingModels,
	parsePricingPage,
	readPricingCache,
	toPricingTable,
	validatePricingTable,
	writePricingCache
} from '../lib/price-source.js'
import { resolvePricing, viewOf, initialState } from '../lib/pricing.js'

const FIXTURE = readFileSync(new URL('./fixtures/pricing-page-table.html', import.meta.url), 'utf8')

function tempCachePath() {
	const dir = mkdtempSync(join(tmpdir(), 'dcp-pricing-'))
	return { path: join(dir, 'pricing.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('解析真实夹具：模型列与四个桶全部正确', () => {
	const { models } = parsePricingPage(FIXTURE)
	assert.deepEqual(models['deepseek-flash'], {
		offpeak: { cacheRead: 0.02, input: 1, output: 4 },
		peak: { cacheRead: 0.04, input: 2, output: 8 }
	})
	assert.deepEqual(models['deepseek-v4-pro'], {
		offpeak: { cacheRead: 0.15, input: 4.5, output: 13.5 },
		peak: { cacheRead: 0.3, input: 9, output: 27 }
	})
	// 页面上还有并发限制(2500/500)、上下文长度(1M) 等数字，绝不能被当成价格
	assert.equal(Object.values(models['deepseek-flash'].offpeak).includes(2500), false)
	assert.equal(Object.values(models['deepseek-flash'].peak).includes(500), false)
})

test('解析：结构不符时抛错（而不是默默给出错数字）', () => {
	assert.throws(() => parsePricingPage('<html><body>nothing</body></html>'), /no table containing/)
	assert.throws(() => parsePricingPage('<table><tr><td>缓存命中</td></tr></table>'), /no model header/)
})

test('校验：官方夹具通过；高峰非两倍、越界、缺 flash 一律拒绝', () => {
	const { models } = parsePricingPage(FIXTURE)
	assert.deepEqual(validatePricingTable(models), [])

	const notDouble = structuredClone(models)
	notDouble['deepseek-flash'].peak.output = 9
	assert.match(validatePricingTable(notDouble).join(';'), /peak \(9\) is not twice off-peak \(4\)/)

	const absurd = structuredClone(models)
	absurd['deepseek-flash'].offpeak.input = 2500
	absurd['deepseek-flash'].peak.input = 5000
	assert.match(validatePricingTable(absurd).join(';'), /implausible/)

	const missingFlash = structuredClone(models)
	delete missingFlash['deepseek-flash']
	missingFlash['deepseek-v4-pro'] = missingFlash['deepseek-v4-pro']
	assert.match(validatePricingTable(missingFlash).join(';'), /no flash-family model/)

	const inverted = structuredClone(models)
	inverted['deepseek-flash'].offpeak.cacheRead = 5
	inverted['deepseek-flash'].peak.cacheRead = 10
	assert.match(validatePricingTable(inverted).join(';'), /cache-hit price is not below cache-miss/)
})

test('补全：cacheWrite 按未命中输入价补齐（官方无独立价）', () => {
	const { models } = parsePricingPage(FIXTURE)
	const table = toPricingTable(models)
	assert.equal(table['deepseek-flash'].offpeak.cacheWrite, 1)
	assert.equal(table['deepseek-flash'].peak.cacheWrite, 2)
})

test('优先级：内置 < 在线抓取 < 用户配置', () => {
	const { models } = parsePricingPage(FIXTURE)
	const online = toPricingTable(models)
	// 在线表把 flash 的命中价改成一个可辨识的值
	online['deepseek-flash'].offpeak.cacheRead = 0.03
	online['deepseek-flash'].peak.cacheRead = 0.06

	const withOnline = resolvePricing(undefined, online)
	assert.equal(withOnline['deepseek-flash'].offpeak.cacheRead, 0.03, '在线价应覆盖内置价')
	// 页面没列到的旧模型名保留内置价，老会话不会变成「价格未知」
	assert.equal(withOnline['deepseek-v4-flash'].offpeak.cacheRead, 0.02)

	const withUser = resolvePricing({ 'deepseek-flash': { offpeak: { cacheRead: 0.09 } } }, online)
	assert.equal(withUser['deepseek-flash'].offpeak.cacheRead, 0.09, '用户配置应覆盖在线价')
})

test('抓取：HTML 夹具 → 价目；失败时降级且不抛', async () => {
	const cache = tempCachePath()
	try {
		const ok = await loadPricingModels({
			cachePath: cache.path,
			fetchImpl: async () => ({ ok: true, status: 200, text: async () => FIXTURE })
		})
		assert.equal(ok.source, 'fetched')
		assert.equal(ok.error, null)
		assert.equal(ok.models['deepseek-flash'].offpeak.input, 1)

		// 缓存命中：即使这次 fetch 会抛错，也不该被调用
		let called = 0
		const cached = await loadPricingModels({
			cachePath: cache.path,
			fetchImpl: async () => {
				called += 1
				throw new Error('should not be called')
			}
		})
		assert.equal(cached.source, 'cache')
		assert.equal(called, 0, 'TTL 内不应重新抓取')

		// 断网 + 缓存过期 → 用过期缓存兜底，并带上原因
		const stale = await loadPricingModels({
			cachePath: cache.path,
			ttlMs: 0,
			fetchImpl: async () => {
				throw new Error('offline')
			}
		})
		assert.equal(stale.source, 'stale-cache')
		assert.match(stale.error, /offline/)
		assert.equal(stale.models['deepseek-flash'].offpeak.output, 4, '过期缓存仍应可用')
	} finally {
		cache.cleanup()
	}
})

test('抓取：校验拒绝但盘上有过期好缓存时，回退到那份缓存（评审发现）', async () => {
	const cache = tempCachePath()
	try {
		// 先写一份已过 TTL 但内容良好的缓存
		const { models } = parsePricingPage(FIXTURE)
		writePricingCache(cache.path, {
			fetchedAt: Date.now() - 2 * DEFAULT_TTL_MS,
			url: PRICING_URL,
			models
		})

		// 本次抓取成功但校验不过（例如页面价格笔误、解析串列）
		const tampered = FIXTURE.replace('0.04元', '9.99元')
		const rejected = await loadPricingModels({
			cachePath: cache.path,
			fetchImpl: async () => ({ ok: true, status: 200, text: async () => tampered })
		})

		assert.equal(rejected.source, 'stale-cache', '应回退到盘上的过期好缓存')
		assert.equal(rejected.models['deepseek-flash'].offpeak.input, 1, '回退后价目可用')
		assert.match(rejected.error, /not twice off-peak/, '拒绝原因保留给界面展示')
	} finally {
		cache.cleanup()
	}
})

test('抓取：校验不通过 → rejected 且不写缓存；完全拿不到 → unavailable', async () => {
	const cache = tempCachePath()
	try {
		const tampered = FIXTURE.replace('0.04元', '9.99元')
		const rejected = await loadPricingModels({
			cachePath: cache.path,
			fetchImpl: async () => ({ ok: true, status: 200, text: async () => tampered })
		})
		assert.equal(rejected.source, 'rejected')
		assert.equal(rejected.models, null)
		assert.match(rejected.error, /not twice off-peak/)
		assert.equal(readPricingCache(cache.path, DEFAULT_TTL_MS), null, '被拒绝的表不应落盘')

		const unavailable = await loadPricingModels({
			cachePath: cache.path,
			fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' })
		})
		assert.equal(unavailable.source, 'unavailable')
		assert.equal(unavailable.models, null)
		assert.match(unavailable.error, /HTTP 503/)
	} finally {
		cache.cleanup()
	}
})

test('缓存：损坏文件与过期文件都视为无缓存', () => {
	const cache = tempCachePath()
	try {
		writeFileSync(cache.path, '{ not json', 'utf8')
		assert.equal(readPricingCache(cache.path, DEFAULT_TTL_MS), null)

		const { models } = parsePricingPage(FIXTURE)
		writePricingCache(cache.path, { fetchedAt: Date.now() - 10 * DEFAULT_TTL_MS, url: 'x', models })
		assert.equal(readPricingCache(cache.path, DEFAULT_TTL_MS), null, '过期缓存不算命中')

		// 内容被篡改成非法价目时也拒绝
		writePricingCache(cache.path, { fetchedAt: Date.now(), url: 'x', models: { 'deepseek-flash': { offpeak: {}, peak: {} } } })
		assert.equal(readPricingCache(cache.path, DEFAULT_TTL_MS), null)
	} finally {
		cache.cleanup()
	}
})

test('视图：带上价目来源元信息，供界面交代「这个数字按哪份价算的」', () => {
	const { models } = parsePricingPage(FIXTURE)
	const pricing = resolvePricing(undefined, toPricingTable(models))
	const meta = { source: 'fetched', url: 'https://example/', checkedAt: '2026-09-10', fetchedAt: 1789000000000, error: null }
	const view = viewOf(initialState(), pricing, meta)
	assert.deepEqual(view.pricing, meta)

	const withoutMeta = viewOf(initialState(), pricing)
	assert.equal('pricing' in withoutMeta, false)
})
