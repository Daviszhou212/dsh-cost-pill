/**
 * dsh-cost-pill · 余额查询与 loopback 围栏（纯逻辑，可单测）
 *
 * 余额来自提供商自己的账户接口：`GET {baseURL}/user/balance`
 * （Bearer 鉴权）。返回体里的 `balance_infos` 是一个按币种分组的数组，
 * 每项带 `total_balance` / `granted_balance` / `topped_up_balance`，
 * 数值可能是字符串（例如 "7.09"），统一在这里归一化成数字。
 *
 * 安全约束：
 *   - 只读接口，除了提供商自己的 API Key 之外不发送任何东西；
 *   - API Key 只在宿主进程内解析、只用于这一次 fetch，**绝不**回给浏览器；
 *   - 路由只接受 loopback 调用者：判定以 peer socket 地址为准，Host 头只作
 *     附加校验（Host 头是客户端可控的，不能作为唯一依据）。
 */

/** 提供商默认值：可被 settings 里 `llm-deepseek` 命名空间的同名字段覆盖。 */
export const DEEPSEEK_DEFAULTS = {
	apiKeyEnv: 'DEEPSEEK_API_KEY',
	baseURL: 'https://api.deepseek.com'
}

/** 是否是 loopback 地址（含 IPv4-mapped IPv6 形式）。 */
export function isLoopbackAddress(address) {
	if (typeof address !== 'string') return false
	const a = address.toLowerCase()
	if (a === '::1') return true
	const ipv4 = a.startsWith('::ffff:') ? a.slice(7) : a
	const octets = ipv4.split('.')
	return (
		octets.length === 4 &&
		octets[0] === '127' &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	)
}

/** 解析 Host 头，兼容带方括号与不带方括号的 IPv6 字面量。 */
export function hostNameOf(value) {
	if (typeof value !== 'string') return null
	const host = value.trim().toLowerCase()
	if (host.startsWith('[')) {
		const close = host.indexOf(']')
		if (close <= 1) return null
		const suffix = host.slice(close + 1)
		if (suffix !== '' && !/^:\d+$/.test(suffix)) return null
		return host.slice(1, close)
	}
	const firstColon = host.indexOf(':')
	const lastColon = host.lastIndexOf(':')
	if (firstColon !== lastColon) return host // 裸 IPv6
	if (lastColon === -1) return host.replace(/\.$/, '')
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null
	return host.slice(0, lastColon).replace(/\.$/, '')
}

/** Host 头是否指向本机。 */
export function isLoopbackHostHeader(headers) {
	const name = hostNameOf(headers?.host)
	return name === 'localhost' || isLoopbackAddress(name)
}

/**
 * 对外来调用的拒绝判定（纯函数，不写响应）：
 * 非 GET → 405；peer 不在 loopback 或 Host 头不是本机 → 403；否则 null（放行）。
 *
 * @param req - Node 请求对象。
 * @returns `{ status, error }` 或 `null`。
 */
export function foreignCallerOf(req) {
	if (req?.method !== 'GET') return { status: 405, error: 'method-not-allowed' }
	const peer = req?.socket?.remoteAddress
	if (isLoopbackAddress(peer) && isLoopbackHostHeader(req.headers)) return null
	return { status: 403, error: 'forbidden' }
}

/** 数值归一化：数字或非空数字字符串 → number；空串/无效值 → undefined（显示为「未知」而不是 0）。 */
export function numOf(value) {
	if (value === null || value === undefined) return undefined
	if (typeof value === 'string' && value.trim() === '') return undefined
	const n = Number(value)
	return Number.isFinite(n) ? n : undefined
}

/** 结构非法错误（providerStatus = 'invalid-response'，与上游不可用区分开）。 */
function invalidResponse(message) {
	const error = new Error(message)
	error.providerStatus = 'invalid-response'
	return error
}

/**
 * 解析余额接口的返回体。
 *
 * @param body - 已 JSON.parse 的返回体。
 * @returns `{ isAvailable, currency, total, granted, toppedUp }`。
 * @throws 结构非法时抛出（providerStatus = 'invalid-response'）。
 */
export function parseBalanceBody(body) {
	const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
	const info = infos.find((entry) => entry?.currency === 'CNY') ?? infos[0]
	// null 也要拦：balance_infos: [null] 时 find 给出的是 null 而不是 undefined
	if (info === undefined || info === null) throw invalidResponse('balance response is missing balance_infos')
	return {
		isAvailable: body?.is_available === true,
		currency: typeof info.currency === 'string' ? info.currency : 'CNY',
		total: numOf(info.total_balance),
		granted: numOf(info.granted_balance),
		toppedUp: numOf(info.topped_up_balance)
	}
}

/** 把上游错误映射成稳定的状态串，供界面区分「没配凭据」与「上游不通」。 */
export function balanceStatusOf(error) {
	if (error?.providerStatus !== undefined) return error.providerStatus
	if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'unavailable'
	return 'unavailable'
}

function providerError(message, httpStatus) {
	const error = new Error(message)
	error.providerStatus =
		httpStatus === 401 || httpStatus === 403
			? 'unauthorized'
			: httpStatus === 429
				? 'rate-limited'
				: httpStatus !== undefined && httpStatus >= 500
					? 'unavailable'
					: 'invalid-response'
	if (httpStatus !== undefined) error.httpStatus = httpStatus
	return error
}

/**
 * 查询余额。只发一次 GET，带超时；任何失败都抛错，由调用方决定怎么降级。
 *
 * @param options - `{ baseURL, apiKey, timeoutMs?, fetchImpl? }`。
 */
export async function queryBalance({ baseURL, apiKey, timeoutMs = 15_000, fetchImpl = fetch }) {
	const url = new URL('/user/balance', baseURL).href
	const response = await fetchImpl(url, {
		headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs)
	})
	if (!response.ok) throw providerError(`balance API returned HTTP ${response.status}`, response.status)
	let body
	try {
		body = await response.json()
	} catch {
		throw providerError('balance API returned invalid JSON')
	}
	return parseBalanceBody(body)
}
