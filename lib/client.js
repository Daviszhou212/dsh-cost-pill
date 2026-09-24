/**
 * dsh-cost-pill · 浏览器半边（client bundle）
 *
 * 手写 CJS + ModuleLoader 包装，零构建步骤（与社区 dsh-annotation 同款做法）：
 * 只依赖 `react`（harness 的模块表必然提供）；图标是自绘内联 SVG，不依赖任何官方图标包
 * ——官方图标是 React 组件，命令式 DOM 层用不了，原因见下方 GLYPHS 的注释。
 *
 * 结构：**React 只做「座位」，界面全部由命令式 DOM 承载**。
 * 官方统计行（StatsPills）与本插件都是 `conversation.composer.dock` 列表插槽的占用者
 * （官方 id 'stats' / order 0，本插件 id 'cost-pill' / order 1），插槽运行时按 order
 * 排序渲染 —— 位置由插槽契约保证，不做任何 DOM 搬运：
 *   - 座位组件只渲染一个 `display:contents` 的占位 span，并用 hooks 读会话投影；
 *   - pill / 面板由 createElement 构建，原地挂进座位，随座位卸载一起销毁。
 *
 * 横向位置：dock 是居中 flex 行，最右端还有一个插槽外的 ContextMeter（上下文余量）。
 * pill 根节点用 `margin-left:auto` 把整组钉在行最右、ContextMeter 左侧；根节点保持
 * 紧凑（flex:none、不占满整行），不去挤压同行的官方 pill。
 * （历史教训：曾依赖官方根节点的 `data-composer-stats` 标记做 DOM 合并 —— 该属性在
 * 当前 DSH 里并不存在，搬运从未发生，pill 长期处于 `width:100%` 独立态把官方 pill
 * 挤出省略号。已改为纯插槽方案。）
 *
 * 视觉参数逐条抄自官方源码（packages/client/ui-chat/src/client/chat/*.module.css）：
 *   - StatsPills：pill 的颜色/字号/gap/padding/hover、sep 的颜色与 margin；
 *   - stat-dialog：面板的底色/阴影/圆角/padding/字号、标题行、分隔线、dl 网格的
 *     列宽与右对齐。面板右对齐锚在 pill 上（贴右放置时不会溢出视口）。
 * 类名加 `dcp_` 前缀，避免与官方混淆；同时自带独立 <style> 标签，随插件卸载可清理。
 *
 * 两路数据：
 *   - 费用：宿主半边注册的 `costPill` 会话投影，经插槽运行时的 useProjection 读取；
 *   - 余额：宿主半边的 loopback 路由 `/api/cost-pill/balance`（API Key 留在宿主进程，
 *     浏览器只拿到余额数字），挂载拉一次、之后每 5 分钟一次，面板里可手动强制刷新。
 */

window.__ModuleLoader__.load({
	// 必须与 package.json 的 name 完全一致，否则 client-modules 会报
	// "bundle loaded without registering ..."
	id: 'dsh-cost-pill',
	factory: (require) => {
		'use strict'
		var module = { exports: {} }
		var exports = module.exports

		var React = require('react')

		var BALANCE_PATH = '/api/cost-pill/balance'
		var BALANCE_INTERVAL_MS = 300_000
		var TREE_PATH = '/api/cost-pill/tree'
		var TREE_INTERVAL_MS = 30_000

		var SVG_NS = 'http://www.w3.org/2000/svg'

		/**
		 * 自绘图标（16 视窗、`currentColor`、描边 1.3–1.5，与官方图标同一套规范）。
		 *
		 * 为什么不用 `@deepseek-ai/dsh-client-ui-primitives` 的官方图标：那些是 **React 组件**，
		 * 而本插件的 pill/面板由命令式 DOM 构建 —— `React.createElement(Icon)` 返回的是 React
		 * 元素对象而不是 DOM 节点，`appendChild` 会直接抛 `TypeError`（这正是上一版整个 pill
		 * 不显示的根因）。要渲染它们就必须引入 react-dom，而 react-dom 并不保证在模块表里存在。
		 * 自绘 SVG 零依赖，也不受上游改名影响。
		 */
		var GLYPHS = {
			// 费用：圆圈里一个 ¥
			cost: [
				{ tag: 'circle', cx: '8', cy: '8', r: '6.25', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' },
				{ tag: 'path', d: 'M5.6 5.4 L8 8.3 L10.4 5.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
				{ tag: 'path', d: 'M8 8.3 V11.1 M6.1 9.5 H9.9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round' }
			],
			// 用量：数据库柱体
			usage: [
				{ tag: 'ellipse', cx: '8', cy: '4', rx: '5', ry: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' },
				{ tag: 'path', d: 'M3 4 V12 C3 13.1 5.24 14 8 14 C10.76 14 13 13.1 13 12 V4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' },
				{ tag: 'path', d: 'M3 8 C3 9.1 5.24 10 8 10 C10.76 10 13 9.1 13 8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }
			],
			// 刷新：带箭头的圆弧
			refresh: [
				{ tag: 'path', d: 'M13.2 8 A5.2 5.2 0 1 1 11.5 4.1', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' },
				{ tag: 'path', d: 'M13.4 2.4 V5.2 H10.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
			]
		}

		/** 造一个 SVG 图标节点（`kind` 见 {@link GLYPHS}）。 */
		function glyph(kind) {
			var node = document.createElementNS(SVG_NS, 'svg')
			node.setAttribute('viewBox', '0 0 16 16')
			node.setAttribute('aria-hidden', 'true')
			for (var shape of GLYPHS[kind] ?? GLYPHS.cost) {
				var element = document.createElementNS(SVG_NS, shape.tag)
				for (var attribute of Object.keys(shape)) {
					if (attribute === 'tag') continue
					element.setAttribute(attribute, shape[attribute])
				}
				node.appendChild(element)
			}
			return node
		}

		// ============================== 样式 ==============================
		var STYLE_ID = 'dsh-cost-pill/client.css'
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') === null) {
			var style = document.createElement('style')
			style.dataset.plugin = 'dsh-cost-pill'
			style.dataset.pluginCss = STYLE_ID
			style.textContent = [
				// 座位不产生盒子，pill 直接成为 dock 容器的子元素（插槽占用者原地渲染）
				'.dcp_seat{display:contents}',
				// pill 根节点：dock flex 行里的一个紧凑子项。margin-left:auto 把整组钉在
				// 行最右端（ContextMeter 左侧）；flex:none 保证自己不被压缩 —— 也因此
				// 绝不能给 width:100% 之类的占满行为，那会把同行官方 pill 挤出省略号。
				'.dcp_root{box-sizing:border-box;max-width:100%;',
				'  font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
				'  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
				'  align-items:center;gap:12px;margin:0 0 0 auto;flex:none;display:flex}',
				'.dcp_anchor{min-width:0;display:inline-flex;position:relative}',
				// —— 与官方 StatsPills.pill 同参数 ——
				'.dcp_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);',
				'  font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;',
				'  background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;',
				'  display:inline-flex;cursor:pointer}',
				'.dcp_pill svg{flex:none;width:14px;height:14px}',
				'.dcp_pill:hover,.dcp_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);',
				'  color:var(--dsw-alias-label-secondary)}',
				'.dcp_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
				// —— 与官方 StatsPills.sep 同参数 ——
				// 0.1.7-alpha 的上游回归：sep token 被官方 CSS 引用却无人定义，兜底到
				// 三级文字色，保证任何版本下分隔点都有可读颜色。
				'.dcp_sep{color:var(--dsw-alias-separator-primary,var(--dsw-alias-label-tertiary));margin:0 6px}',
				'.dcp_glyph{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;',
				'  justify-content:center;font-size:12px;line-height:1}',
				// —— 与官方 stat-dialog.panel 同参数，自锚定在 pill 上、向上展开 ——
				// pill 贴行最右，面板右缘对齐锚点（left:50% 平移会在贴右时溢出视口）。
				// 0.1.7-alpha 起 --dsw-specific-menu 改为半透明色（浅 #f8f9fa94 / 深
				// #30313680），官方面板配套加了毛玻璃 backdrop-filter；不跟的话内容直接透底。
				'.dcp_panel{position:absolute;bottom:calc(100% + 8px);right:0;',
				'  z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);',
				'  backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));',
				'  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));',
				'  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
				'  width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);',
				'  box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);',
				'  cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;',
				'  text-align:left;white-space:normal}',
				'.dcp_panelTitle{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;',
				'  margin-bottom:8px;font-weight:500;display:flex}',
				'.dcp_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
				'.dcp_titleLabel svg{flex:none;width:14px;height:14px}',
				'.dcp_titleValue{font-variant-numeric:tabular-nums}',
				'.dcp_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
				'.dcp_details{color:var(--dsw-alias-label-tertiary);',
				'  grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
				'.dcp_details dt,.dcp_details dd{min-width:0;margin:0}',
				'.dcp_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;',
				'  text-align:right;overflow-wrap:anywhere}',
				'.dcp_section{margin-top:12px}',
				'.dcp_sectionTitle{color:var(--dsw-alias-label-primary);font-weight:500;align-items:center;',
				'  gap:6px;margin-bottom:6px;display:flex}',
				'.dcp_sectionTitle svg{flex:none;width:14px;height:14px}',
				'.dcp_sectionHead{display:flex;align-items:center;justify-content:space-between;gap:16px;',
				'  margin-bottom:6px}',
				'.dcp_sectionHead .dcp_sectionTitle{margin-bottom:0}',
				'.dcp_refresh{background:0 0;border:none;border-radius:24px;padding:2px 8px;font:inherit;',
				'  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;',
				'  align-items:center;gap:4px;display:inline-flex}',
				'.dcp_refresh:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);',
				'  color:var(--dsw-alias-label-secondary)}',
				'.dcp_refresh[disabled]{cursor:default;opacity:.6}',
				'.dcp_refresh svg{flex:none;width:11px;height:11px}',
				'.dcp_refresh[data-spin=true] svg{animation:dcp_spin .8s linear infinite}',
				'@keyframes dcp_spin{to{transform:rotate(360deg)}}',
				'.dcp_model{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 16px;',
				'  font-variant-numeric:tabular-nums}',
				'.dcp_modelKey{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
				'.dcp_modelMeta{color:var(--dsw-alias-label-tertiary);grid-column:1/-1}',
				'.dcp_warn{color:var(--dsw-alias-state-error-primary)}',
				'.dcp_note{color:var(--dsw-alias-label-tertiary);margin-top:12px;font-size:11px;line-height:16px}'
			].join('\n')
			document.head.appendChild(style)
		}

		// ============================== 文案 ==============================
		var DICT = {
			zh: {
				pill: '费用',
				hit: '命中',
				title: '本会话 API 费用',
				period: '计费时段',
				periodPeak: '高峰',
				periodOffpeak: '空闲',
				periodMixed: '高峰 + 空闲',
				uncachedInput: '未缓存输入',
				cacheRead: '缓存读取',
				cacheWrite: '缓存写入',
				output: '输出',
				peakCost: '高峰费用',
				offpeakCost: '空闲费用',
				updated: '更新于',
				models: '分模型',
				rates: '单价（元 / 百万 token）',
				ratesLine: '缓存命中 {hit} · 未命中 {miss} · 输出 {out}（空闲），高峰 ×2',
				priceSource: '价目来源',
				srcBuiltin: '内置价目',
				srcFetched: '在线刷新自官方定价页',
				srcCache: '本地缓存（本轮未重新抓取）',
				srcStaleCache: '在线刷新失败，用上次抓到的价目',
				srcRejected: '在线价目未通过校验，已回退',
				srcUnavailable: '在线刷新不可用，用内置价目',
				checkedAt: '核验于',
				reasonPrefix: '原因：',
				unknownPrice: '价格未知（用 pricing 覆盖）',
				note: '估算值：token 取自 provider 上报用量，单价来自内置价目表。',
				balance: '余额',
				balanceTitle: '账户余额',
				toppedUp: '充值余额',
				granted: '赠送余额',
				balanceRefresh: '刷新',
				refreshing: '刷新中…',
				balanceUnavailable: '余额不可用',
				errNoCredential: '未找到 API Key（凭据缝里没有该环境变量）',
				errUnauthorized: 'API Key 无效或被拒绝',
				errRateLimited: '请求过于频繁，稍后再试',
				errInvalidResponse: '上游返回无法解析',
				errUnreachable: '本机路由不可达（插件可能未加载）',
				errUnavailable: '上游不可用',
				subagentsTitle: '子代理会话',
				subagents: '子代理 ×{n}',
				subagentOwn: '本会话',
				subagentTotal: '合计（含子代理）',
				includeNote: '费用含整棵子代理树'
			},
			en: {
				pill: 'Cost',
				hit: 'hit',
				title: 'Session API cost',
				period: 'Tariff',
				periodPeak: 'Peak',
				periodOffpeak: 'Off-peak',
				periodMixed: 'Peak + off-peak',
				uncachedInput: 'Uncached input',
				cacheRead: 'Cached input',
				cacheWrite: 'Cache write',
				output: 'Output',
				peakCost: 'Peak cost',
				offpeakCost: 'Off-peak cost',
				updated: 'Updated',
				models: 'By model',
				rates: 'Rates (CNY / 1M tokens)',
				ratesLine: 'cache hit {hit} · miss {miss} · output {out} off-peak, peak ×2',
				priceSource: 'Price source',
				srcBuiltin: 'built-in table',
				srcFetched: 'refreshed from the official pricing page',
				srcCache: 'local cache (not refetched this run)',
				srcStaleCache: 'refresh failed, using the last fetched table',
				srcRejected: 'fetched table failed validation, reverted',
				srcUnavailable: 'refresh unavailable, using the built-in table',
				checkedAt: 'checked',
				reasonPrefix: 'reason: ',
				unknownPrice: 'rate not specified (override with pricing)',
				note: 'Estimate: tokens come from provider-reported usage; rates come from the built-in table.',
				balance: 'Balance',
				balanceTitle: 'Account balance',
				toppedUp: 'Topped up',
				granted: 'Granted',
				balanceRefresh: 'Refresh',
				refreshing: 'Refreshing…',
				balanceUnavailable: 'Balance unavailable',
				errNoCredential: 'no API key found in the credentials seam',
				errUnauthorized: 'API key rejected',
				errRateLimited: 'rate limited, retry later',
				errInvalidResponse: 'unparseable upstream response',
				errUnreachable: 'local route unreachable (plugin may not be loaded)',
				errUnavailable: 'provider unavailable',
				subagentsTitle: 'Subagent sessions',
				subagents: 'Subagents ×{n}',
				subagentOwn: 'This session',
				subagentTotal: 'Total (incl. subagents)',
				includeNote: 'cost includes the full subagent tree'
			}
		}

		function pickDict(locale) {
			return String(locale || '').toLowerCase().startsWith('zh') ? DICT.zh : DICT.en
		}

		// ============================== 工具 ==============================
		function h(tag, props, children) {
			var node = document.createElement(tag)
			if (props !== undefined && props !== null) {
				for (var key of Object.keys(props)) {
					var value = props[key]
					if (value === undefined || value === null) continue
					if (key === 'className') node.className = value
					else if (key === 'text') node.textContent = value
					else if (key === 'style') node.setAttribute('style', value)
					else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
					else node.setAttribute(key, value)
				}
			}
			if (children !== undefined) {
				for (var child of [].concat(children)) {
					if (child === null || child === undefined) continue
					node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
				}
			}
			return node
		}

		/** 命令式层绝不能把 React 元素当 DOM 节点用（见 GLYPHS 注释）：一律走 glyph()。 */

		function formatTokens(value) {
			var n = Number(value) || 0
			if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
			if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
			return String(Math.round(n))
		}

		function formatMoney(value) {
			var n = Number(value) || 0
			if (n >= 100) return '¥' + n.toFixed(2)
			if (n >= 1) return '¥' + n.toFixed(3)
			return '¥' + n.toFixed(4)
		}

		function formatPercent(rate) {
			return rate === null || rate === undefined ? '—' : (rate * 100).toFixed(1) + '%'
		}

		function formatClock(ms) {
			var t = Number(ms)
			if (!Number.isFinite(t) || t <= 0) return '—'
			var d = new Date(t)
			return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
		}

		function balanceTotalOf(data) {
			if (data === null || data === undefined || data.ok !== true) return undefined
			var total = data.balance === undefined || data.balance === null ? undefined : data.balance.total
			return typeof total === 'number' && Number.isFinite(total) ? total : undefined
		}

		function isLowBalance(data) {
			var total = balanceTotalOf(data)
			var threshold = data === null || data === undefined ? undefined : data.lowThreshold
			return typeof total === 'number' && typeof threshold === 'number' && total < threshold
		}

		function balanceErrorText(dict, data) {
			var code = data === null || data === undefined ? 'unavailable' : data.error
			if (code === 'no-credential') return dict.errNoCredential
			if (code === 'unauthorized') return dict.errUnauthorized
			if (code === 'rate-limited') return dict.errRateLimited
			if (code === 'invalid-response') return dict.errInvalidResponse
			if (code === 'unreachable') return dict.errUnreachable
			return dict.errUnavailable
		}

		/**
		 * 价目来源 → 文案（含核验日期）。
		 *
		 * @param dict - 当前语言词典。
		 * @param meta - 视图里的 `pricing` 元信息；缺失时视为内置价目。
		 */
		function priceSourceText(dict, meta) {
			var source = meta === null || meta === undefined ? 'builtin' : meta.source
			var label =
				source === 'fetched'
					? dict.srcFetched
					: source === 'cache'
						? dict.srcCache
						: source === 'stale-cache'
							? dict.srcStaleCache
							: source === 'rejected'
								? dict.srcRejected
								: source === 'unavailable'
									? dict.srcUnavailable
									: dict.srcBuiltin
			var checked = meta === null || meta === undefined ? undefined : meta.checkedAt
			return checked === undefined || checked === '' ? label : label + ' · ' + dict.checkedAt + ' ' + checked
		}

		// ============================== 命令式界面 ==============================
		/**
		 * 建一套 pill + 面板，原地挂在插槽座位里。
		 *
		 * 位置完全由插槽契约保证（官方 stats order 0 → 本插件 order 1，均渲染在 dock
		 * flex 行里），横向靠 CSS `margin-left:auto` 钉在最右端。不做任何 DOM 搬运、
		 * 不需要 MutationObserver —— React 重排只会重渲染座位自己的子树，动不到 root。
		 *
		 * @param options - `{ holder, ctx }`。
		 */
		function mountCostUi(options) {
			var holder = options.holder
			var ctx = options.ctx
			var locale = localeOf(ctx)
			var dict = pickDict(locale)
			var view = undefined
			var balance = null
			var open = false
			var refreshing = false
			var disposed = false

			var panel = null
			var panelSignature = null
			var refreshButton = null
			var tree = null
			var currentSession = undefined
			var labelNode = h('span', { className: 'dcp_label' })
			var pillButton = h(
				'button',
				{
					type: 'button',
					className: 'dcp_pill',
					'aria-expanded': 'false',
					onClick: function () {
						open = !open
						render()
					}
				},
				[glyph('cost'), labelNode]
			)
			var anchor = h('span', { className: 'dcp_anchor' }, [pillButton])
			var root = h('span', { className: 'dcp_root' }, [anchor])
			holder.appendChild(root)

			/** 面板内容：标题（总额）+ 本会话明细 + 账户余额 + 子代理 + 分模型 + 单价 + 说明。 */
			function buildPanel() {
				var tokens = (view === undefined || view === null ? {} : view.tokens) || {}
				var mixed = (view.peakCost ?? 0) > 0 && (view.offpeakCost ?? 0) > 0
				var periodText = mixed ? dict.periodMixed : (view.peakCost ?? 0) > 0 ? dict.periodPeak : dict.periodOffpeak
				var topRates = view.models !== undefined && view.models.length > 0 ? view.models[0].rates : undefined
				var total = balanceTotalOf(balance)
				var low = isLowBalance(balance)
				var info = balance !== null && balance !== undefined && balance.ok === true ? balance.balance : null
				var treeOk = tree !== null && tree !== undefined && tree.ok === true
				var subCount = treeOk && tree.subagents !== undefined ? tree.subagents.count : 0
				var subCost = treeOk && typeof tree.subagents?.cost === 'number' ? tree.subagents.cost : undefined
				var costShown = subCount > 0 && treeOk && typeof tree.total === 'number' ? tree.total : view.cost
				var unpricedSuffix = view.unpriced !== undefined && view.unpriced.length > 0 ? '+' : ''

				var rows = [
					[dict.period, periodText],
					[dict.uncachedInput, formatTokens(tokens.input) + ' tok'],
					[dict.cacheRead, formatTokens(tokens.cacheRead) + ' tok'],
					tokens.cacheWrite > 0 ? [dict.cacheWrite, formatTokens(tokens.cacheWrite) + ' tok'] : null,
					[dict.output, formatTokens(tokens.output) + ' tok'],
					[dict.peakCost, formatMoney(view.peakCost)],
					[dict.offpeakCost, formatMoney(view.offpeakCost)],
					[dict.hit, formatPercent(view.cacheHitRate)],
					[dict.updated, formatClock(view.updatedAt)]
				].filter(function (row) {
					return row !== null
				})

				var details = h('dl', { className: 'dcp_details' })
				rows.forEach(function (row) {
					details.appendChild(h('dt', { text: row[0] }))
					details.appendChild(h('dd', { text: row[1] }))
				})

				var nodes = [
					h('div', { className: 'dcp_panelTitle' }, [
						h('span', { className: 'dcp_titleLabel' }, [glyph('cost'), dict.title]),
						h('span', { className: 'dcp_titleValue', text: formatMoney(costShown) + unpricedSuffix })
					]),
					h('div', { className: 'dcp_rule' }),
					details
				]

				// —— 账户余额 ——
				refreshButton = h(
					'button',
					{
						type: 'button',
						className: 'dcp_refresh',
						'data-spin': refreshing ? 'true' : 'false',
						onClick: function () {
							loadBalance(true)
						}
					},
					[glyph('refresh'), refreshing ? dict.refreshing : dict.balanceRefresh]
				)
				if (refreshing) refreshButton.setAttribute('disabled', 'disabled')
				var balanceBody
				if (info !== null) {
					balanceBody = h('dl', { className: 'dcp_details' })
					var balanceRows = [
						[dict.balance, formatMoney(info.total), low],
						[dict.toppedUp, formatMoney(info.toppedUp), false],
						[dict.granted, formatMoney(info.granted), false],
						[dict.updated, formatClock(balance === null ? undefined : balance.fetchedAt), false]
					]
					balanceRows.forEach(function (row) {
						balanceBody.appendChild(h('dt', { text: row[0] }))
						balanceBody.appendChild(h('dd', { className: row[2] ? 'dcp_warn' : undefined, text: row[1] }))
					})
				} else {
					balanceBody = h('div', {
						className: 'dcp_modelMeta dcp_warn',
						text: dict.balanceUnavailable + '（' + balanceErrorText(dict, balance) + '）'
					})
				}
				nodes.push(
					h('div', { className: 'dcp_section' }, [
						h('div', { className: 'dcp_sectionHead' }, [
							h('div', { className: 'dcp_sectionTitle', text: dict.balanceTitle }),
							refreshButton
						]),
						balanceBody
					])
				)

				if (view.models !== undefined && view.models.length > 0) {
					var modelNodes = view.models.map(function (model) {
						return h('div', { className: 'dcp_model' }, [
							h('span', { className: 'dcp_modelKey', text: model.key }),
							h('span', {
								className: model.priced ? undefined : 'dcp_warn',
								text: model.priced ? formatMoney(model.cost) : dict.unknownPrice
							}),
							h('span', {
								className: 'dcp_modelMeta',
								text: formatTokens(model.tokens?.total) + ' tok · ' + dict.hit + ' ' + formatPercent(model.cacheHitRate)
							})
						])
					})
					nodes.push(
						h('div', { className: 'dcp_section' }, [
							h('div', { className: 'dcp_sectionTitle' }, [glyph('usage'), dict.models])
						].concat(modelNodes))
					)
				}

				// —— 子代理树：有派生会话时给出拆分（本会话 / 子代理 / 合计） ——
				if (treeOk && subCount > 0) {
					var memberRows = []
					if (tree.subagents.members !== undefined) {
						for (var member of tree.subagents.members.slice(0, 8)) {
							memberRows.push([member.key.slice(0, 24), formatMoney(member.cost) + ' · ' + member.samples + ' 样本', false])
						}
					}
					var subBody = h('dl', { className: 'dcp_details' })
					var subRows = [
						[dict.subagentOwn, formatMoney(view.cost)],
						[dict.subagents.replace('{n}', String(subCount)), formatMoney(subCost), low],
						[dict.subagentTotal, formatMoney(costShown), false]
					]
					subRows.forEach(function (row) {
						subBody.appendChild(h('dt', { text: row[0] }))
						subBody.appendChild(h('dd', { className: row[2] ? 'dcp_warn' : undefined, text: row[1] }))
					})
					for (var memberRow of memberRows) {
						subBody.appendChild(h('dt', { text: memberRow[0] }))
						subBody.appendChild(h('dd', { text: memberRow[1] }))
					}
					nodes.push(
						h('div', { className: 'dcp_section' }, [
							h('div', { className: 'dcp_sectionTitle', text: dict.subagentsTitle }),
							subBody
						])
					)
				}

				if (topRates !== undefined) {
					nodes.push(
						h('div', { className: 'dcp_section' }, [
							h('div', { className: 'dcp_sectionTitle', text: dict.rates }),
							h('div', {
								className: 'dcp_modelMeta',
								text: dict.ratesLine
									.replace('{hit}', String(topRates.offpeak.cacheRead))
									.replace('{miss}', String(topRates.offpeak.input))
									.replace('{out}', String(topRates.offpeak.output))
							}),
							// 价目来源：用户据此判断「这个数字是按哪份价目、什么时候核对的」
							h('div', {
								className: view.pricing?.error === null || view.pricing?.error === undefined ? 'dcp_modelMeta' : 'dcp_modelMeta dcp_warn',
								text:
									dict.priceSource +
									'：' +
									priceSourceText(dict, view.pricing) +
									(view.pricing?.error === null || view.pricing?.error === undefined ? '' : '（' + dict.reasonPrefix + view.pricing.error + '）')
							})
						])
					)
				}

				nodes.push(h('div', { className: 'dcp_note', text: dict.note }))
				return h('div', { className: 'dcp_panel', role: 'dialog' }, nodes)
			}

			/** 依据当前 view / tree / balance / open 重画（节点尽量复用）。 */
			function render() {
				var visible = view !== undefined && view !== null && (view.samples ?? 0) > 0
				root.style.display = visible ? '' : 'none'
				if (!visible) return

				var treeOk = tree !== null && tree !== undefined && tree.ok === true
				var treeTotal = treeOk && typeof tree.total === 'number' ? tree.total : undefined
				var subCount = treeOk && tree.subagents !== undefined ? tree.subagents.count : 0
				var subCost = treeOk && typeof tree.subagents?.cost === 'number' ? tree.subagents.cost : undefined
				// 显示口径：配置开启且树数据可用时，费用 = 本会话 + 整棵子代理树
				var costShown = subCount > 0 && treeTotal !== undefined ? treeTotal : view.cost
				// 有未定价模型的用量被静默按 0 计入时，主数字必须带「+」：金额只是已定价部分的下限
				var unpricedSuffix = view.unpriced !== undefined && view.unpriced.length > 0 ? '+' : ''

				var segments = [{ text: dict.pill + ' ' + formatMoney(costShown) + unpricedSuffix, warn: false }]
				var total = balanceTotalOf(balance)
				var low = isLowBalance(balance)
				if (typeof total === 'number') segments.push({ text: dict.balance + ' ' + formatMoney(total), warn: low })
				segments.push({ text: dict.hit + ' ' + formatPercent(view.cacheHitRate), warn: false })
				if (subCount > 0) segments.push({ text: dict.includeNote, warn: false })

				labelNode.textContent = ''
				segments.forEach(function (segment, index) {
					if (index > 0) labelNode.appendChild(h('span', { className: 'dcp_sep', 'aria-hidden': 'true', text: '·' }))
					labelNode.appendChild(h('span', { className: segment.warn ? 'dcp_warn' : undefined, text: segment.text }))
				})
				pillButton.setAttribute('aria-expanded', open ? 'true' : 'false')

				if (open) {
					// 内容没变就不重建面板：重建会让正在阅读的面板闪动、丢文本选区、
					// 重启刷新按钮的旋转动画。签名覆盖所有会影响面板内容的输入。
					var signature = JSON.stringify([
						view.cost,
						view.peakCost,
						view.offpeakCost,
						view.cacheHitRate,
						view.updatedAt,
						view.pricing ?? null,
						total,
						low,
						balance === null || balance === undefined ? null : balance.error,
						balance === null || balance === undefined ? null : balance.fetchedAt,
						refreshing,
						open,
						locale,
						treeTotal,
						subCount,
						subCost
					])
					if (panel === null || signature !== panelSignature) {
						if (panel !== null) panel.remove()
						panel = buildPanel()
						anchor.appendChild(panel)
						panelSignature = signature
					}
				} else if (panel !== null) {
					panel.remove()
					panel = null
					panelSignature = null
				}
			}

			// —— 余额：挂载拉一次，之后定时拉；手动刷新走 ?refresh=1 ——
			var timer = null
			var balanceSeq = 0
			var panelSignature = null
			var BALANCE_TIMEOUT_MS = 15_000

			function loadBalance(force) {
				if (disposed) return Promise.resolve()
				// 单调序号：只有**最新一次**请求的结果允许写入状态。否则手动刷新（走上游、慢）
				// 会被先发出后到的自动拉取（读宿主缓存、快）用旧值覆盖——按钮已恢复但数据是旧的。
				var seq = ++balanceSeq
				if (force) {
					refreshing = true
					render()
				}
				return fetch(BALANCE_PATH + (force ? '?refresh=1' : ''), {
					headers: { accept: 'application/json' },
					// 宿主路由挂起时不能让刷新按钮转几分钟：超时按不可达处理
					signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS)
				})
					.then(function (response) {
						return response.json()
					})
					.then(function (data) {
						if (disposed || seq !== balanceSeq) return
						balance = data
					})
					.catch(function () {
						if (disposed || seq !== balanceSeq) return
						balance = { ok: false, error: 'unreachable' }
					})
					.then(function () {
						if (disposed || seq !== balanceSeq) return
						refreshing = false
						render()
					})
			}

			// —— 语言跟随 ——
			var unsubscribeLocale = null
			var unsubscribeSessions = null
			if (ctx !== undefined && ctx.sessions !== undefined && ctx.sessions.list !== undefined && typeof ctx.sessions.list.subscribe === 'function') {
				try {
					unsubscribeSessions = ctx.sessions.list.subscribe(function () {
						var next = currentSessionId()
						if (next !== currentSession) {
							currentSession = next
							loadTree()
						}
					})
				} catch {
					unsubscribeSessions = null
				}
			}
			if (ctx !== undefined && ctx.locale !== undefined && typeof ctx.locale.subscribe === 'function') {
				try {
					unsubscribeLocale = ctx.locale.subscribe(function () {
						locale = localeOf(ctx)
						dict = pickDict(locale)
						render()
					})
				} catch {
					unsubscribeLocale = null
				}
			}

			// —— 点外部 / Esc 收起 ——
			function onPointerDown(event) {
				if (open && !anchor.contains(event.target)) {
					open = false
					render()
				}
			}
			function onKeyDown(event) {
				if (open && event.key === 'Escape') {
					open = false
					render()
				}
			}
			document.addEventListener('mousedown', onPointerDown)
			document.addEventListener('keydown', onKeyDown)

			timer = setInterval(function () {
				loadBalance(false)
			}, BALANCE_INTERVAL_MS)
			loadBalance(false)

			// —— 含子代理树的费用汇总：跟随本 pill 所在会话，30 秒一轮 ——
			// 会话 id 优先取插槽注入的 sessionId（conversation.composer.dock 是 session
			// 作用域插槽，标准 props 携带 sessionId）；缺省时退回 sessions store 里找
			// mainView 占用的会话（官方 workspace/cordis 插件同款判定）。
			function currentSessionId() {
				if (ctx === undefined || ctx.sessions === undefined || ctx.sessions.list === undefined) return undefined
				try {
					var byId = ctx.sessions.list.getSnapshot().byId
					for (var id in byId) {
						if (((byId[id] ?? {}).retainedBy?.mainView ?? 0) > 0) return id
					}
					return undefined
				} catch {
					return undefined
				}
			}
			function loadTree() {
				var injected = options.sessionId
				var sessionId = typeof injected === 'string' && injected !== '' ? injected : currentSessionId()
				if (disposed || sessionId === undefined || sessionId === null || sessionId === '') return Promise.resolve()
				return fetch(TREE_PATH + '?session=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
					.then(function (response) {
						return response.json()
					})
					.then(function (data) {
						if (disposed || data === null || data === undefined || data.ok !== true) return
						tree = data
						render()
					})
					.catch(function () {
						/* 路由失败保持现状：pill 继续用投影的本会话费用 */
					})
			}
			var treeTimer = setInterval(function () {
				loadTree()
			}, TREE_INTERVAL_MS)
			loadTree()

			return {
				setView: function (next) {
					view = next
					render()
				},
				dispose: function () {
					disposed = true
					if (timer !== null) clearInterval(timer)
					if (treeTimer !== null) clearInterval(treeTimer)
					if (typeof unsubscribeLocale === 'function') unsubscribeLocale()
					if (typeof unsubscribeSessions === 'function') unsubscribeSessions()
					document.removeEventListener('mousedown', onPointerDown)
					document.removeEventListener('keydown', onKeyDown)
					root.remove()
				}
			}
		}

		/** 取当前界面语言。 */
		function localeOf(ctx) {
			if (ctx !== undefined && ctx.locale !== undefined && typeof ctx.locale.getSnapshot === 'function') {
				try {
					return ctx.locale.getSnapshot().active
				} catch {
					return 'zh'
				}
			}
			return 'zh'
		}

		// ============================== 座位组件 ==============================
		/**
		 * 插槽座位：只渲染一个 `display:contents` 的占位 span，把投影值推给命令式界面。
		 * hooks 必须待在 React 组件里，所以数据读取留在这一层。
		 */
		function makeSeat(ctx) {
			return function CostPillSeat(props) {
				var view = typeof props.useProjection === 'function' ? props.useProjection('costPill') : undefined
				var holderRef = React.useRef(null)
				var uiRef = React.useRef(null)
				React.useEffect(function () {
					if (holderRef.current === null) return undefined
					var ui = mountCostUi({ holder: holderRef.current, ctx: ctx, sessionId: props.sessionId })
					uiRef.current = ui
					return function () {
						ui.dispose()
						uiRef.current = null
					}
				}, [])
				React.useEffect(
					function () {
						if (uiRef.current !== null) uiRef.current.setView(view)
					},
					[view]
				)
				return React.createElement('span', { className: 'dcp_seat', ref: holderRef })
			}
		}

		// ============================== 注册 ==============================
		/**
		 * 客户端插件主体：把费用/余额 pill 注册进输入框下方的 dock 列表槽。
		 *
		 * `order: 1` 让本插件排在官方统计行（order 0）之后；运行时按注册项逐个渲染，
		 * 并注入 `useProjection`（读取会话投影）等会话作用域 hook。
		 */
		function apply(ctx) {
			ctx.slots.inject('conversation.composer.dock', function () {
				return ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'cost-pill',
						order: 1
					},
					makeSeat(ctx)
				)
			})
		}

		exports.apply = apply
		exports.inject = ['slots', 'locale', 'sessions']
		return module.exports
	}
})

