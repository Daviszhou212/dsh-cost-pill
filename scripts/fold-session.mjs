/**
 * 拿一份真实会话日志跑本插件的折叠逻辑，打印费用 —— 用于和平台账单人工对账。
 *
 * 用法：
 *   node scripts/fold-session.mjs "$DSH_HOME/sessions/<workspace>/<session>/session.v3.jsonl.zstd"
 *   node scripts/fold-session.mjs <日志> --peak-price 2 --offpeak-price 1   # 覆盖未命中输入单价
 *
 * 说明：会话日志是**追加式多帧 zstd**（每次追加写一个新帧），Node 的
 * zstdDecompressSync 只解第一帧，所以这里按魔数切帧逐个解压。
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

import { applyEvent, initialState, resolvePricing, viewOf } from '../lib/pricing.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 多帧 zstd → 文本（按魔数切帧）。 */
function decompressFrames(file) {
	const buffer = readFileSync(file)
	const offsets = []
	for (let i = 0; (i = buffer.indexOf(ZSTD_MAGIC, i)) >= 0; i++) offsets.push(i)
	let text = ''
	let cursor = 0
	while (cursor < offsets.length) {
		let decoded = false
		for (let end = cursor + 1; end <= offsets.length; end++) {
			const stop = end < offsets.length ? offsets[end] : buffer.length
			try {
				text += zstdDecompressSync(buffer.subarray(offsets[cursor], stop)).toString('utf8')
				cursor = end
				decoded = true
				break
			} catch {
				/* 试下一个切点 */
			}
		}
		if (!decoded) break
	}
	return text
}

const file = process.argv[2]
if (file === undefined) {
	console.error('用法: node scripts/fold-session.mjs <session.v3.jsonl.zstd>')
	process.exit(2)
}

const events = decompressFrames(file)
	.split('\n')
	.filter((line) => line.trim() !== '')
	.map((line) => {
		try {
			return JSON.parse(line)
		} catch {
			return null
		}
	})
	.filter((event) => event !== null)

let state = initialState()
for (const event of events) state = applyEvent(state, event)

const view = viewOf(state, resolvePricing(undefined))
console.log(`事件数      ${events.length}`)
console.log(`计费样本    ${view.samples}`)
console.log(`tokens      未缓存 ${view.tokens.input} · 缓存读 ${view.tokens.cacheRead} · 缓存写 ${view.tokens.cacheWrite} · 输出 ${view.tokens.output}（合计 ${view.tokens.total}）`)
console.log(`命中率      ${view.cacheHitRate === null ? '—' : (view.cacheHitRate * 100).toFixed(1) + '%'}`)
console.log(`高峰 / 空闲 ¥${view.peakCost.toFixed(4)} / ¥${view.offpeakCost.toFixed(4)}`)
console.log(`合计        ¥${view.cost.toFixed(4)}`)
for (const model of view.models) {
	console.log(`  ${model.key}  ${model.priced ? '¥' + model.cost.toFixed(4) : '价格未知'}  ${model.tokens.total} tok  命中 ${model.cacheHitRate === null ? '—' : (model.cacheHitRate * 100).toFixed(1) + '%'}`)
}
