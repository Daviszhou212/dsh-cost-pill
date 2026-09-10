/**
 * 余额层单测：loopback 围栏、返回体解析、错误映射、查询本身（用假 fetch）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
	balanceStatusOf,
	foreignCallerOf,
	hostNameOf,
	isLoopbackAddress,
	isLoopbackHostHeader,
	numOf,
	parseBalanceBody,
	queryBalance
} from '../lib/balance.js'

test('loopback 判定：IPv4 / IPv4-mapped IPv6 / ::1 / 非本机', () => {
	assert.equal(isLoopbackAddress('127.0.0.1'), true)
	assert.equal(isLoopbackAddress('::1'), true)
	assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
	assert.equal(isLoopbackAddress('192.168.1.10'), false)
	assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false)
	assert.equal(isLoopbackAddress(undefined), false)
})

test('Host 头解析：带端口、裸 IPv6、方括号 IPv6、localhost', () => {
	assert.equal(hostNameOf('127.0.0.1:3080'), '127.0.0.1')
	assert.equal(hostNameOf('localhost:3080'), 'localhost')
	assert.equal(hostNameOf('[::1]:3080'), '::1')
	assert.equal(hostNameOf('::1'), '::1')
	assert.equal(hostNameOf('example.com:443'), 'example.com')
	assert.equal(isLoopbackHostHeader({ host: 'localhost:3080' }), true)
	assert.equal(isLoopbackHostHeader({ host: 'evil.example:3080' }), false)
})

test('围栏：peer 是本机但 Host 头不是本机 → 仍然拒绝', () => {
	const req = { method: 'GET', headers: { host: 'evil.example' }, socket: { remoteAddress: '127.0.0.1' } }
	assert.deepEqual(foreignCallerOf(req), { status: 403, error: 'forbidden' })
})

test('围栏：本机 GET 放行；非 GET 405；远端 403', () => {
	const ok = { method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }
	assert.equal(foreignCallerOf(ok), null)
	assert.deepEqual(foreignCallerOf({ ...ok, method: 'POST' }), { status: 405, error: 'method-not-allowed' })
	assert.deepEqual(
		foreignCallerOf({ ...ok, socket: { remoteAddress: '10.1.2.3' } }),
		{ status: 403, error: 'forbidden' }
	)
})

test('数值归一化：数字、数字字符串、无效值', () => {
	assert.equal(numOf('7.09'), 7.09)
	assert.equal(numOf(0), 0)
	assert.equal(numOf(null), undefined)
	assert.equal(numOf('abc'), undefined)
})

test('返回体解析：优先 CNY，字符串数值归一化', () => {
	const parsed = parseBalanceBody({
		is_available: true,
		balance_infos: [
			{ currency: 'USD', total_balance: '15.00', granted_balance: '0', topped_up_balance: '15.00' },
			{ currency: 'CNY', total_balance: '107.54', granted_balance: '0.00', topped_up_balance: '107.54' }
		]
	})
	assert.equal(parsed.currency, 'CNY')
	assert.equal(parsed.total, 107.54)
	assert.equal(parsed.toppedUp, 107.54)
	assert.equal(parsed.granted, 0)
	assert.equal(parsed.isAvailable, true)
})

test('返回体解析：没有 CNY 时取第一项；缺 balance_infos 抛错', () => {
	const usdOnly = parseBalanceBody({ balance_infos: [{ currency: 'USD', total_balance: 1 }] })
	assert.equal(usdOnly.currency, 'USD')
	assert.equal(usdOnly.total, 1)
	assert.throws(() => parseBalanceBody({}), /balance_infos/)
})

test('错误映射：HTTP 状态 → 稳定状态串', () => {
	assert.equal(balanceStatusOf(Object.assign(new Error('x'), { providerStatus: 'unauthorized' })), 'unauthorized')
	assert.equal(balanceStatusOf(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'unavailable')
	assert.equal(balanceStatusOf(new Error('boom')), 'unavailable')
})

test('查询：带 Bearer 头打 /user/balance，非 2xx 抛错', async () => {
	const calls = []
	const fetchImpl = async (url, init) => {
		calls.push({ url, init })
		return { ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '1.23' }] }) }
	}
	const balance = await queryBalance({ baseURL: 'https://api.deepseek.com', apiKey: 'sk-test', fetchImpl })
	assert.equal(balance.total, 1.23)
	assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
	assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')

	const failing = async () => ({ ok: false, status: 401, json: async () => ({}) })
	await assert.rejects(
		() => queryBalance({ baseURL: 'https://api.deepseek.com', apiKey: 'sk-bad', fetchImpl: failing }),
		(error) => {
			assert.equal(balanceStatusOf(error), 'unauthorized')
			return true
		}
	)
})
