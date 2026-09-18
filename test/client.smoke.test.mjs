/**
 * 浏览器半边冒烟测试：用一个极简 DOM 垫片 + React 替身，把真实 client bundle 跑起来。
 *
 * 覆盖（对应评审指出的零覆盖区）：
 *   1. 合并：官方统计行在时，pill 挂进那一行（`data-composer-stats` 锚点）；
 *   2. 恢复：官方行被抹掉 → 降级独立行；新官方行出现 → 自动重新合并
 *      （通过可派发的 MutationObserver + 可 flush 的 rAF 队列驱动，不再用空操作垫片）；
 *   3. 投影 undefined → 有值：pill 从隐藏变为显示；
 *   4. dispose：rAF 不再 place、document 监听被清空；
 *   5. 面板内容齐备；余额失败/成功两态；官方图标包存在时也必须正常挂载；
 *   6. 面板在数据未变时不重建（不闪动、不丢监听）。
 *
 * 垫片只实现本插件真正用到的那部分 DOM/React 契约。关键时序对齐真实 React：
 * **先提交 DOM，再跑 effect**（否则挂载时拿不到父节点）；rAF 进队列、由测试显式 flush。
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
			if (name.startsWith('data-')) {
				this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value)
			}
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
		},
		querySelector(selector) {
			const match = /^\[([a-zA-Z-]+)\]$/.exec(selector)
			if (match === null) return null
			const attribute = match[1]
			const walk = (node) => {
				for (const child of node.childNodes ?? []) {
					if (child.attributes !== undefined && child.attributes[attribute] !== undefined) return child
					const deeper = walk(child)
					if (deeper !== null) return deeper
				}
				return null
			}
			return walk(this)
		}
	}
}

/** 可控的 document / MutationObserver / rAF：测试用 flush* 驱动异步节奏。 */
function installDom() {
	const listeners = {}
	const observers = []
	const rafQueue = []
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
		/** 测试手动派发一次变更。 */
		flush() {
			if (!this.disconnected) this.callback([{ type: 'childList' }], this)
		}
	}
	globalThis.requestAnimationFrame = (fn) => {
		const entry = { fn, cancelled: false }
		rafQueue.push(entry)
		return entry
	}
	globalThis.cancelAnimationFrame = (entry) => {
		if (entry && typeof entry === 'object') entry.cancelled = true
	}
	return {
		flushObservers() {
			for (const observer of observers) observer.flush()
		},
		flushRaf() {
			for (const entry of rafQueue.splice(0)) {
				if (!entry.cancelled) entry.fn()
			}
		},
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
	dom.flushRaf()
})

/**
 * 造一个 dock 容器（可选带官方统计行），挂载座位组件。
 * `options.getView()` 提供投影值；`rerender()` 在视图变化后重新渲染座位。
 */
function mountDock(definition, react, options) {
	const container = makeElement('div')
	if (options.withStatsRow === true) {
		const official = makeElement('div')
		official.setAttribute('data-composer-stats', 'true')
		official.appendChild(makeElement('span'))
		container.appendChild(official)
	}
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
	module.apply({
		slots: {
			inject(_name, fn) {
				fn()
			},
			register(_options, registered) {
				component = registered
				return () => {}
			}
		}
	})
	const rendered = react.render(component, { useProjection: () => options.getView() }, container)
	activeDisposers.push(rendered.dispose)
	// 注意合并态下 root 在官方行**内部**，所以要深度查找，不能只看直接子节点
	const root = () => container.querySelector('[data-merged]')
	return {
		container,
		officialRow: container.querySelector('[data-composer-stats]'),
		root,
		dispose: rendered.dispose,
		rerender: () => react.render(component, { useProjection: () => options.getView() }, container)
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

test('合并：官方统计行在时，pill 被挂进那一行（同排）', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, withStatsRow: true, getView: () => view })

	const merged = dock.officialRow.childNodes.filter((child) => child.getAttribute?.('data-merged') === 'true')
	assert.equal(merged.length, 1, 'pill 的 root 应被合并进官方统计行')
	assert.equal(findButton(dock.officialRow) !== null, true, 'pill 按钮应在官方行内部')
	assert.equal(
		dock.container.childNodes.filter(
			(child) => child.getAttribute?.('data-merged') !== undefined && child !== dock.officialRow
		).length,
		0,
		'容器里不应再留一份'
	)
})

test('恢复：官方行被抹掉后降级独立行；新官方行出现后自动重新合并', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, withStatsRow: true, getView: () => view })
	const root = dock.root()

	// 官方行被 React 抹掉
	dock.officialRow.remove()
	dom.flushObservers()
	dom.flushRaf()
	assert.equal(root.parentElement, dock.container, '官方行消失后应降级为独立一行（挂在容器）')
	assert.equal(root.getAttribute('data-merged'), 'false')

	// 新官方行出现（React 重排后再渲染）
	const newRow = makeElement('div')
	newRow.setAttribute('data-composer-stats', 'true')
	dock.container.appendChild(newRow)
	dom.flushObservers()
	dom.flushRaf()
	assert.equal(root.parentElement, newRow, '新官方行出现后应重新合并')
})

test('投影 undefined → 有值：pill 从隐藏变为显示', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	let view = undefined
	const dock = mountDock(definition, react, { getView: () => view, withStatsRow: false })
	const root = dock.root()
	assert.equal(root.style.display, 'none', '无投影值时隐藏')

	view = SAMPLE_VIEW
	dock.rerender()
	assert.equal(root.style.display, '', '投影有值后应显示')
	assert.match(findButton(dock.container).textContent, /费用 ¥2\.033/)
})

test('dispose：rAF 不再搬运、document 监听被清空', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, withStatsRow: true, getView: () => view })
	const root = dock.root()
	assert.equal(root.parentElement, dock.officialRow)

	const before = dom.listenerCount('mousedown') + dom.listenerCount('keydown')
	assert.ok(before > 0, '挂载时应注册 document 级监听')
	dock.dispose()
	assert.equal(dom.listenerCount('mousedown') + dom.listenerCount('keydown'), 0, 'dispose 应清空 document 监听')

	// dispose 后官方行被抹掉：rAF 已取消，root 不会被再次搬运
	dock.officialRow.remove()
	dom.flushObservers()
	dom.flushRaf()
	assert.equal(root.parentElement, null, 'dispose 后不再放置')
})

test('内容：pill 文案与面板（明细 / 账户余额 / 分模型 / 单价 / 价目来源）齐备', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({
		json: async () => ({ ok: true, balance: { total: 107.54, granted: 0, toppedUp: 107.54 }, lowThreshold: 10, fetchedAt: Date.now() })
	})
	const view = SAMPLE_VIEW
	const dock = mountDock(definition, react, { view, withStatsRow: true, getView: () => view })
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
	const dock = mountDock(definition, react, { view, withStatsRow: false, getView: () => view })
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
	const failed = mountDock(definition, reactFailed, { view, withStatsRow: false, getView: () => view })
	await tick()
	const failedButton = findButton(failed.container)
	assert.doesNotMatch(failedButton.textContent, /余额/, '余额拿不到时 pill 不应出现余额段')
	failedButton.dispatch('click', {})
	assert.match(collectText(failed.container), /余额不可用/)

	const reactOk = createReact()
	globalThis.fetch = async () => ({
		json: async () => ({ ok: true, balance: { total: 8.5, granted: 0, toppedUp: 8.5 }, lowThreshold: 10, fetchedAt: Date.now() })
	})
	const ok = mountDock(definition, reactOk, { view, withStatsRow: false, getView: () => view })
	await tick()
	assert.match(findButton(ok.container).textContent, /余额 ¥8\.500/, '余额应出现在 pill 上')
})

/** 等一轮微任务，让 fetch 的 then 链跑完。 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0))
}
