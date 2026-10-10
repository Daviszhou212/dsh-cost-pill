/**
 * 智谱 GLM Coding Plan 额度层单测：返回体解析（unit 分类 / 兜底启发式 / MCP 归集）、
 * 查询本身（假 fetch：无 Bearer 的 Authorization 头、URL、HTTP 错误映射、坏 JSON）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseZaiQuotaBody, queryZaiQuota } from '../lib/zai-quota.js'

/** 2026-10-10 open.bigmodel.cn 个人 Pro 套餐的实测响应（原文照抄）。 */
const REAL_BODY = {
	code: 200,
	msg: 'Operation successful',
	success: true,
	data: {
		limits: [
			{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 3601, remaining: 8398, percentage: 30, nextResetTime: 1791635714693 },
			{ type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 12563, remaining: 47436, percentage: 20, nextResetTime: 1791956556998 }
		],
		level: 'pro'
	}
}

test('解析：实测 Pro 响应 → level + 5h/周双窗口 + 无 MCP', () => {
	const q = parseZaiQuotaBody(REAL_BODY)
	assert.equal(q.level, 'pro')
	assert.deepEqual(q.fiveHour, { usedPercent: 30, used: 3601, limit: 12000, remaining: 8398, resetAt: 1791635714693 })
	assert.equal(q.weekly.usedPercent, 20)
	assert.equal(q.weekly.resetAt, 1791956556998)
	assert.equal(q.mcp, undefined)
})

test('解析：老套餐单条 TOKENS_LIMIT → 仅 5h 窗', () => {
	const q = parseZaiQuotaBody({ data: { level: 'Lite', limits: [{ type: 'TOKENS_LIMIT', percentage: 7 }] } })
	assert.equal(q.level, 'Lite')
	assert.equal(q.fiveHour.usedPercent, 7)
	assert.equal(q.weekly, null)
})

test('解析：unit 缺失 → 无 reset 归 5h，早 reset 归周窗（cc-switch 同款兜底）', () => {
	const q = parseZaiQuotaBody({
		data: { limits: [
			{ type: 'tokens_limit', percentage: 40, nextResetTime: 2000 },
			{ type: 'CREDIT_LIMIT', percentage: 10 }
		] }
	})
	assert.equal(q.fiveHour.usedPercent, 10)
	assert.equal(q.weekly.usedPercent, 40)
})

test('解析：TIME_LIMIT → MCP 月度；unit 只认 3/6，其余进兜底', () => {
	const q = parseZaiQuotaBody({
		data: { limits: [
			{ type: 'CREDIT_LIMIT', unit: 3, percentage: 1 },
			{ type: 'TIME_LIMIT', percentage: 55, usage: 100, currentValue: 55, remaining: 45 }
		] }
	})
	assert.equal(q.mcp.usedPercent, 55)
	assert.equal(q.mcp.remaining, 45)
	assert.equal(q.weekly, null)
})

test('解析：结构非法 → invalid-response', () => {
	assert.throws(() => parseZaiQuotaBody({ data: { limits: [{ type: 'OTHER', percentage: 1 }] } }), /no usable limits/)
	assert.throws(() => parseZaiQuotaBody(null), /missing data/)
})

test('查询：URL / 无 Bearer 的 Authorization / 通用头', async () => {
	const calls = []
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), init })
		return { ok: true, status: 200, json: async () => REAL_BODY }
	}
	const q = await queryZaiQuota({ host: 'https://open.bigmodel.cn', apiKey: 'sk-zai', fetchImpl })
	assert.equal(calls.length, 1)
	assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
	assert.equal(calls[0].init.headers.authorization, 'sk-zai')
	assert.equal(calls[0].init.headers['content-type'], 'application/json')
	assert.equal(calls[0].init.headers['accept-language'], 'en-US,en')
	assert.equal(q.level, 'pro')
})

test('查询：401 → unauthorized；坏 JSON → invalid-response', async () => {
	const respond = (response) => async () => response
	await assert.rejects(
		queryZaiQuota({ host: 'https://api.z.ai', apiKey: 'k', fetchImpl: respond({ ok: false, status: 401, json: async () => ({}) }) }),
		(error) => error.providerStatus === 'unauthorized'
	)
	await assert.rejects(
		queryZaiQuota({ host: 'https://api.z.ai', apiKey: 'k', fetchImpl: respond({ ok: true, status: 200, json: async () => { throw new Error('bad') } }) }),
		(error) => error.providerStatus === 'invalid-response'
	)
})
