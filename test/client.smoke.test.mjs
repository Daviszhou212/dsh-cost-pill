/**
 * 浏览器半边冒烟测试：用一个极简 DOM 垫片 + React 替身，把真实 client bundle 跑起来，
 * 断言四件事：
 *   1. 有官方统计行时，pill 被合并进那一行（`data-composer-stats` 锚点）；
 *   2. 没有官方统计行时，降级为自成一行；
 *   3. 点开面板后内容齐备（明细 / 账户余额 / 分模型 / 单价）；
 *   4. 余额失败与成功两条路径分别渲染成原因文案与数字。
 *
 * 垫片只实现本插件真正用到的那部分 DOM/React 契约，不追求通用。关键时序对齐真实
 * React：**先提交 DOM，再跑 effect**（否则挂载时拿不到父节点）。
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

function installDom() {
	globalThis.document = {
		head: makeElement('head'),
		body: makeElement('body'),
		createElement: (tag) => makeElement(tag),
		createElementNS: (_namespace, tag) => makeElement(tag),
		createTextNode: (text) => ({ text: String(text), parentElement: null, childNodes: [] }),
		querySelector: () => null,
		addEventListener() {},
		removeEventListener() {}
	}
	globalThis.requestAnimationFrame = (fn) => {
		fn()
		return 1
	}
	globalThis.cancelAnimationFrame = () => {}
	globalThis.MutationObserver = class {
		observe() {}
		disconnect() {}
	}
}

//#endregion

//#region React 替身

/**
 * 够用的 React 替身：字符串类型 → 真实节点（并接上 ref），函数组件 → 直接调用；
 * `render()` 先提交 DOM 再执行 effect，与 React 的提交顺序一致。
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
				node.appendChild(typeof child === 'string' ? { ...makeText(child) } : child)
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
		/**
		 * 渲染一个函数组件并挂到 mountInto（模拟 React 提交 + effect 时序）。
		 * 返回 `{ element, dispose }`，dispose 会执行 effect 返回的清理函数 —— 客户端
		 * 半边的定时器/观察者都在那里释放，测试不调用就会挂住进程。
		 */
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

/**
 * 装入 client bundle，返回注册定义。
 *
 * 注意 ESM 模块只执行一次：`import` 会被缓存，所以定义在首次导入后缓存下来复用；
 * 而 `definition.factory(...)` 每次都新建一份模块实例，测试之间互不干扰。
 */
let cachedDefinition = null

async function loadBundle() {
	if (cachedDefinition !== null) return cachedDefinition
	const captured = { definition: null }
	globalThis.window = {
		__ModuleLoader__: {
			load(definition) {
				captured.definition = definition
			}
		}
	}
	installDom()
	await import('../lib/client.js')
	assert.equal(captured.definition?.id, 'dsh-cost-pill', 'bundle 应注册自己的 id')
	cachedDefinition = captured.definition
	return cachedDefinition
}

/**
 * 造一个 dock 容器（可选带官方统计行），挂载座位组件并返回相关节点。
 * 每个测试挂载出来的 UI 都登记在 activeDisposers，由 afterEach 统一释放
 * （否则里面的 setInterval 会挂住测试进程）。
 */
const activeDisposers = []

test.afterEach(() => {
	for (const dispose of activeDisposers.splice(0)) dispose()
})

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
	const rendered = react.render(component, { useProjection: () => options.view }, container)
	activeDisposers.push(rendered.dispose)
	return { container, officialRow: container.querySelector('[data-composer-stats]'), dispose: rendered.dispose }
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
	const { container, officialRow } = mountDock(definition, react, { view: SAMPLE_VIEW, withStatsRow: true })

	const merged = officialRow.childNodes.filter((child) => child.getAttribute?.('data-merged') === 'true')
	assert.equal(merged.length, 1, 'pill 的 root 应被合并进官方统计行')
	assert.equal(findButton(officialRow) !== null, true, 'pill 按钮应在官方行内部')
	assert.equal(container.childNodes.filter((child) => child.getAttribute?.('data-merged') !== undefined).length, 0, '容器里不应再留一份')
})

test('降级：没有官方统计行时，pill 自成一行挂在 dock 容器里', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'unavailable' }) })
	const { container } = mountDock(definition, react, { view: SAMPLE_VIEW, withStatsRow: false })

	const standalone = container.childNodes.find((child) => child.getAttribute?.('data-merged') === 'false')
	assert.notEqual(standalone, undefined, '没有官方行时应降级为独立一行')
	assert.equal(standalone.className, 'dcp_root')
	assert.equal(findButton(standalone) !== null, true)
})

test('内容：pill 文案与面板（明细 / 账户余额 / 分模型 / 单价）齐备', async () => {
	const definition = await loadBundle()
	const react = createReact()
	globalThis.fetch = async () => ({
		json: async () => ({ ok: true, balance: { total: 107.54, granted: 0, toppedUp: 107.54 }, lowThreshold: 10, fetchedAt: Date.now() })
	})
	const { container } = mountDock(definition, react, { view: SAMPLE_VIEW, withStatsRow: true })
	await tick()

	const button = findButton(container)
	assert.notEqual(button, null, '应渲染出 pill 按钮')
	assert.match(button.textContent, /费用 ¥2\.033/)
	assert.match(button.textContent, /命中 99\.6%/)
	assert.match(button.textContent, /余额 ¥107\.54/)
	// 图标必须是真实 DOM 节点（SVG），不能是 React 元素对象
	const glyphNode = button.childNodes.find((child) => child.tagName === 'SVG')
	assert.notEqual(glyphNode, undefined, 'pill 里应有自绘 SVG 图标')

	button.dispatch('click', {})
	const texts = collectText(container)
	assert.match(texts, /本会话 API 费用/)
	assert.match(texts, /未缓存输入/)
	assert.match(texts, /账户余额/)
	assert.match(texts, /充值余额/)
	assert.match(texts, /deepseek-official\/deepseek-flash/)
	assert.match(texts, /缓存命中 0\.02 · 未命中 1 · 输出 4/)
})

test('余额：失败时 pill 不带余额段并给出原因；成功时带出数字', async () => {
	const definition = await loadBundle()

	const reactFailed = createReact()
	globalThis.fetch = async () => {
		throw new Error('offline')
	}
	const failed = mountDock(definition, reactFailed, { view: SAMPLE_VIEW, withStatsRow: true })
	await tick()
	const failedButton = findButton(failed.container)
	assert.doesNotMatch(failedButton.textContent, /余额/, '余额拿不到时 pill 不应出现余额段')
	failedButton.dispatch('click', {})
	assert.match(collectText(failed.container), /余额不可用/)
	assert.match(collectText(failed.container), /本机路由不可达/)

	const reactOk = createReact()
	globalThis.fetch = async () => ({
		json: async () => ({ ok: true, balance: { total: 8.5, granted: 0, toppedUp: 8.5 }, lowThreshold: 10, fetchedAt: Date.now() })
	})
	const ok = mountDock(definition, reactOk, { view: SAMPLE_VIEW, withStatsRow: true })
	await tick()
	assert.match(findButton(ok.container).textContent, /余额 ¥8\.500/, '余额应出现在 pill 上')
})

/** 等一轮微任务，让 fetch 的 then 链跑完。 */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0))
}


