/**
 * 浏览器半边冒烟测试：用一个极简 DOM 垫片 + React 替身，把真实 client bundle 跑起来。
 *
 * 覆盖：
 *   1. 原地渲染：root 挂在插槽座位内部，不做任何 DOM 搬运（不建 MutationObserver、
 *      不碰座位之外的节点）——放置完全交给插槽 order 与 CSS，这是对旧「合并/搬运」
 *      方案的回归护栏；
 *   2. 投影 undefined → 有值：pill 从隐藏变为显示；
 *   3. dispose：root 摘除、document 监听被清空；
 *   4. 面板内容齐备；余额失败/成功两态；未定价模型金额带「+」；官方图标包存在时也
 *      必须正常挂载；
 *   5. 面板在数据未变时不重建（不闪动、不丢监听）；
 *   6. 树汇总：pill 显示含子代理树的总费用，面板给出父/子拆分。
 *
 * 垫片只实现本插件真正用到的那部分 DOM/React 契约。关键时序对齐真实 React：
 * **先提交 DOM，再跑 effect**（否则挂载 effect 拿不到 holder）；rAF/观察者队列保留
 * 垫片是为了证明新方案根本不再使用它们。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

//#region 极简 DOM 垫片

function makeElement(tag) {
	return {
		tagName: String(tag).toUpperCase(),
		childNodes: [],
		attributes: {},
		style: {},
		dataset: {},
		parentElement: null,
		className: '',
		listeners: {},
		set textContent(value) {
			this.childNodes = []
			if (value !== '' && value !== null && value !== undefined) {
				this.childNodes.push({ text: String(value), parentElement: this })
			}
		},
		get textContent() {
			return this.childNodes.map((child) => (child.text !== undefined ? child.text : child.textContent)).join('')
		},
		setAttribute(name, value) {
			this.attributes[name] = String(value)
			if (name === 'class') this.className = String(value)
		},
		getAttribute(name) {
			return this.attributes[name]
		},
		removeAttribute(name) {
			delete this.attributes[name]
		},
		appendChild(child) {
			if (child.parentElement !== null) child.remove()
			child.parentElement = this
			this.childNodes.push(child)
			return child
		},
		remove() {
			const parent = this.parentElement
			if (parent === null) return
			parent.childNodes = parent.childNodes.filter((child) => child !== this)
			this.parentElement = null
		},
		addEventListener(type, handler) {
			;(this.listeners[type] ??= []).push(handler)
		},
		removeEventListener(type, handler) {
			if (this.listeners[type] === undefined) return
			this.listeners[type] = this.listeners[type].filter((entry) => entry !== handler)
		},
		dispatch(type, event) {
			for (const handler of [...(this.listeners[type] ?? [])]) handler(event)
		},
		contains(node) {
			let cursor = node
			while (cursor !== null && cursor !== undefined) {
				if (cursor === this) return true
				cursor = cursor.parentElement
			}
			return false
		}
	}
}

/** 可控的 document / MutationObserver / rAF：观察者计数用于证明新方案不再创建它们。 */
function installDom() {
	const listeners = {}
	const observers = []
	globalThis.document = {
		head: makeElement('head'),
		body: makeElement('body'),
		createElement: (tag) => makeElement(tag),
		createElementNS: (_namespace, tag) => makeElement(tag),
		createTextNode: (text) => ({ text: String(text), parentElement: null, childNodes: [] }),
		querySelector: () => null,
		addEventListener: (type, handler) => {
			;(listeners[type] ??= []).push(handler)
		},
		removeEventListener: (type, handler) => {
			listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== handler)
		},
		listenerCount: (type) => (listeners[type] ?? []).length
	}
	globalThis.MutationObserver = class {
		constructor(callback) {
			this.callback = callback
			this.disconnected = false
			observers.push(this)
		}
		observe() {}
		disconnect() {
			this.disconnected = true
		}
	}
	globalThis.requestAnimationFrame = (fn) => ({ fn, cancelled: false })
	globalThis.cancelAnimationFrame = (entry) => {
		if (entry && typeof entry === 'object') entry.cancelled = true
	}
	return {
		observerCount: () => observers.length,
		listenerCount: (type) => (listeners[type] ?? []).length
	}
}

//#endregion

//#region React 替身

/**
 * 够用的 React 替身。`render()` 先提交 DOM 再执行 effect（对齐 React 时序）；
 * 支持对同一组件反复 render（slots 持久化、deps 比较决定 effect 是否重跑），
 * 并返回 dispose 以执行 effect 的清理函数。
 */
function createReact() {
	let cursor = 0
	let slots = []
	let pending = []

	const React = {
		createElement(type, props, ...children) {
			if (typeof type !== 'string') return { type, props: props ?? {}, children }
			const node = makeElement(type)
			if (props !== undefined && props !== null) {
				if (props.className !== undefined) node.className = props.className
				if (props.ref !== undefined && typeof props.ref === 'object') props.ref.current = node
			}
			for (const child of children.flat()) {
				if (child === null || child === undefined || child === false) continue
				node.appendChild(typeof child === 'string' ? makeText(child) : child)
			}
			return node
		},
		useRef(initial) {
			const index = cursor++
			slots[index] ??= { current: initial }
			return slots[index]
		},
		useEffect(fn, deps) {
			const index = cursor++
			const previous = slots[index]
			const changed =
				previous === undefined ||
				deps === undefined ||
				previous.deps === undefined ||
				deps.length !== previous.deps.length ||
				deps.some((value, i) => !Object.is(value, previous.deps[i]))
			if (changed) pending.push(fn)
			slots[index] = { deps }
		}
	}

	return {
		React,
		render(component, props, mountInto) {
			cursor = 0
			pending = []
			const element = component(props)
			if (mountInto !== undefined && element !== null) mountInto.appendChild(element)
			const cleanups = pending.map((fn) => fn()).filter((fn) => typeof fn === 'function')
			return {
				element,
				dispose() {
					for (const cleanup of cleanups) cleanup()
				}
			}
		}
	}
}

function makeText(text) {
	return { text, parentElement: null, childNodes: [] }
}

//#endregion

// 垫片与 window 在导入 bundle 之前就装好（bundle 顶层就要用 document/window）
const dom = installDom()
let captured = { definition: null }
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			captured.definition = definition
		}
	}
}

/** ESM 只执行一次：首次导入后缓存注册定义复用；factory 每次调用都新建实例。 */
let cachedDefinition = null

async function loadBundle() {
	if (cachedDefinition !== null) return cachedDefinition
	await import('../lib/client.js')
	assert.equal(captured.definition?.id, 'dsh-cost-pill', 'bundle 应注册自己的 id')
	cachedDefinition = captured.definition
	return cachedDefinition
}

const activeDisposers = []

test.afterEach(() => {
	for (const dispose of activeDisposers.splice(0)) dispose()
})

/** 深度优先找指定 className 的节点。 */
function findByClass(node, className) {
	if (node.className === className) return node
	for (const child of node.childNodes ?? []) {
		const found = findByClass(child, className)
		if (found !== null && found !== undefined) return found
	}
	return null
}

/**
 * 挂载座位组件到一个假 dock 容器。`options.getView()` 提供投影值；
 * `rerender()` 在视图变化后重新渲染座位。
 */
function mountDock(definition, react, options) {
	const container = makeElement('div')
	let component = null
	const module = definition.factory((name) => {
		if (name === 'react') return react.React
		// 回归护栏：官方图标包确实存在时也必须能正常挂载。若代码把 React 元素当 DOM 节点
		// 交给 appendChild（曾经的真实 bug），这里的替身会让它当场抛错。
		if (name === '@deepseek-ai/dsh-client-ui-primitives') {
			return {
				IconDataOutline16: function IconDataOutline16() {},
				IconDatabaseOutline16: function IconDatabaseOutline16() {},
				IconRefreshOutline14: function IconRefreshOutline14() {}
			}
		}
		throw new Error(`unexpected require: ${name}`)
	})
	const fakeCtx = {
		slots: {
			inject(_name, fn) {
				fn()
			},
			register(_options, registered) {
				component = registered
				return () => {}
			}
		}
	}
	module.apply(fakeCtx)
	const rendered = react.render(component, { useProjection: () => options.getView(), sessionId: options.sessionId }, container)
	activeDisposers.push(rendered.dispose)
	return {
		container,
		root: () => findByClass(container, 'dcp_root'),
		dispose: rendered.dispose,
		rerender: () => react.render(component, { useProjection: () => options.getView(), sessionId: options.sessionId }, container)
	}
}

/** 深度优先找第一个 button。 */
function findButton(node) {
	for (const child of node.childNodes ?? []) {
		if (child.tagName === 'BUTTON') return child
		const deeper = findButton(child)
		if (deeper !== null) return deeper
	}
	return null
}

/** 收集子树全部文本。 */
function collectText(node) {
	let text = node.textContent ?? ''
	for (const child of node.childNodes ?? []) text += ' ' + collectText(child)
	return text
}

const SAMPLE_VIEW = {
	cost: 2.033,
	peakCost: 0,
	offpeakCost: 2.033,
	unpriced: [],
	models: [
		{
			key: 'deepseek-official/deepseek-flash',
			priced: true,
			cost: 2.033,
			rates: {
				offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
				peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
			},
			tokens: { input: 200000, cacheRead: 47000000, cacheWrite: 0, output: 180000, total: 47380000 },
			cacheHitRate: 0.9957,
			peakTokens: 0,
			offpeakTokens: 47380000
		}
	],
	tokens: { input: 200000, cacheRead: 47000000, cacheWrite: 0, output: 180000, total: 47380000 },
	cacheHitRate: 0.9957,
	updatedAt: Date.now(),
	samples: 196
}

test('原地渲染：root 挂在座位内部，不建观察者、不做任何 DOM 搬运', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, getView: () => view })

	const root = dock.root()
	assert.notEqual(root, null, 'root 应已挂进座位')
	assert.equal(root.parentElement.className, 'dcp_seat', 'root 的父节点必须是座位 span（display:contents）')
	assert.equal(root.parentElement.parentElement, dock.container, '座位应直接挂在 dock 容器里')
	assert.equal(findButton(root) !== null, true, 'pill 按钮应在 root 内部')
	assert.equal(dom.observerCount(), 0, '新方案不应创建任何 MutationObserver（放置由插槽契约保证）')

	// 重渲染（React 重排）后 root 仍原地不动 —— 不再有「被抹掉再挂回」的把戏
	dock.rerender()
	assert.equal(dock.root(), root, 'rerender 后 root 应保持同一引用、同一位置')
})

test('投影 undefined → 有值：pill 从隐藏变为显示', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	let view = undefined
	const dock = mountDock(definition, react, { getView: () => view })
	const root = dock.root()
	assert.equal(root.style.display, 'none', '无投影值时隐藏')

	view = SAMPLE_VIEW
	dock.rerender()
	assert.equal(root.style.display, '', '投影有值后应显示')
	assert.match(findButton(dock.container).textContent, /费用 ¥2\.033/)
})

test('dispose：root 摘除、document 监听被清空', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, getView: () => view })
	assert.notEqual(dock.root(), null)

	const before = dom.listenerCount('mousedown') + dom.listenerCount('keydown')
	assert.ok(before > 0, '挂载时应注册 document 级监听')
	dock.dispose()
	assert.equal(dom.listenerCount('mousedown') + dom.listenerCount('keydown'), 0, 'dispose 应清空 document 监听')
	assert.equal(dock.root(), null, 'dispose 应把 root 从 DOM 摘除')
})

test('未定价模型：pill 金额带「+」后缀（金额只是已定价部分的下限）', async () => {
	const definition = await loadBundle()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const view = { ...SAMPLE_VIEW, unpriced: ['zai-coding-cn/glm-5.3-flash'] }
	const unpriced = mountDock(definition, createReact(), { view, getView: () => view })
	assert.match(findButton(unpriced.container).textContent, /费用 ¥2\.033\+/, 'unpriced 非空时主金额应带 +')

	const priced = mountDock(definition, createReact(), { view: SAMPLE_VIEW, getView: () => SAMPLE_VIEW })
	assert.doesNotMatch(findButton(priced.container).textContent, /¥2\.033\+/, '全部定价时不应带 +')
})

test('内容：pill 文案与面板（明细 / 账户余额 / 分模型 / 单价 / 价目来源）齐备', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({
		json: async () => ({ ok: true, balance: { total: 107.54, granted: 0, toppedUp: 107.54 }, lowThreshold: 10, fetchedAt: Date.now() })
	})
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, getView: () => view })
	await tick()

	const button = findButton(dock.container)
	assert.notEqual(button, null, '应渲染出 pill 按钮')
	assert.match(button.textContent, /费用 ¥2\.033/)
	assert.match(button.textContent, /余额 ¥107\.54/)
	assert.match(button.textContent, /命中 99\.6%/)
	assert.notEqual(button.childNodes.find((child) => child.tagName === 'SVG'), undefined, 'pill 里应有自绘 SVG 图标')

	button.dispatch('click', {})
	const texts = collectText(dock.container)
	assert.match(texts, /本会话 API 费用/)
	assert.match(texts, /未缓存输入/)
	assert.match(texts, /账户余额/)
	assert.match(texts, /充值余额/)
	assert.match(texts, /deepseek-official\/deepseek-flash/)
	assert.match(texts, /缓存命中 0\.02 · 未命中 1 · 输出 4/)
	assert.match(texts, /价目来源/)
})

test('面板：数据未变时连续 render 不重建面板 DOM', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, getView: () => view })
	const button = findButton(dock.container)
	button.dispatch('click', {})

	const anchor = dock.root().childNodes[0]
	const panelA = anchor.childNodes[anchor.childNodes.length - 1]
	dock.rerender()
	const panelB = anchor.childNodes[anchor.childNodes.length - 1]
	assert.equal(panelA, panelB, '数据未变时面板节点应保持同一引用（不闪动/不丢监听）')
})

test('余额：失败时 pill 不带余额段并给出原因；成功时带出数字', async () => {
	const definition = await loadBundle()

	const reactFailed = createReact()
	globalThis.fetch = async () => {
		throw new Error('offline')
	}
	const view = SAMPLE_VIEW
	const failed = mountDock(definition, reactFailed, { view, getView: () => view })
	await tick()
	const failedButton = findButton(failed.container)
	assert.doesNotMatch(failedButton.textContent, /余额/, '余额拿不到时 pill 不应出现余额段')
	failedButton.dispatch('click', {})
	assert.match(collectText(failed.container), /余额不可用/)

	const reactOk = createReact()
	globalThis.fetch = async () => ({
		json: async () => ({ ok: true, balance: { total: 8.5, granted: 0, toppedUp: 8.5 }, lowThreshold: 10, fetchedAt: Date.now() })
	})
	const ok = mountDock(definition, reactOk, { view, getView: () => view })
	await tick()
	assert.match(findButton(ok.container).textContent, /余额 ¥8\.500/, '余额应出现在 pill 上')
})

test('树汇总：pill 显示含子代理树的总费用，面板给出父/子拆分', async () => {
	const definition = await loadBundle()
	const react = createReact()
	const sessionId = 'session-ec36df5a-a7c9-44c2-b5b7-3e83e911db50'
	globalThis.fetch = async (url) => {
		const u = String(url)
		if (u.includes('/api/cost-pill/tree')) {
			return {
				json: async () => ({
					ok: true,
					sessionId: 'session-ec36df5a-a7c9-44c2-b5b7-3e83e911db50',
					total: 19.5321,
					subagents: { count: 20, cost: 17.4154, members: [{ key: '82128951', cost: 1.3727, samples: 74 }] },
					fetchedAt: Date.now()
				})
			}
		}
		if (u.includes('/api/cost-pill/balance')) {
			return { json: async () => ({ ok: true, balance: { total: 137.41, granted: 0, toppedUp: 137.41 }, lowThreshold: 10, fetchedAt: Date.now() }) }
		}
		return { json: async () => ({}) }
	}
	const dock = mountDock(definition, react, {
		view: SAMPLE_VIEW,
		getView: () => SAMPLE_VIEW,
		sessionId
	})
	await tick()

	const button = findButton(dock.container)
	assert.match(button.textContent, /费用 ¥19\.532/, 'pill 费用应为含子代理树的总费用')
	assert.match(button.textContent, /余额 ¥137\.41/)

	button.dispatch('click', {})
	const texts = collectText(dock.container)
	assert.match(texts, /子代理会话/)
	assert.match(texts, /本会话/)
	assert.match(texts, /子代理 ×20/)
	assert.match(texts, /¥17\.415/, '子代理小计应出现')
	assert.match(texts, /¥2\.033/, '本会话明细应保留')
})

/** 等一轮微任务，让 fetch 的 then 链跑完。 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0))
}
