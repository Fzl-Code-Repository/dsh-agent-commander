/**
 * WorkBuddy / codebuddy 的登录：外部浏览器设备码流程。
 *
 * 为什么要在插件里做这件事，而不是让用户自己跑 `codebuddy login`：
 *   - `codebuddy login` 是 TUI 里的斜杠命令，`-p` 非交互模式下跑不了；
 *   - 整个流程其实就是两个 HTTP 调用（见下），自己实现比驱动 TUI 稳得多；
 *   - 授权完成后把 token 写进 codebuddy 认的位置，后续派活直接用。
 *
 * 流程（与 CLI 内部 AccountScopedAuth 完全一致）：
 *   1. POST /v2/plugin/auth/state?platform=CLI  → { state, authUrl }
 *   2. 用户在弹出的浏览器页面里完成登录
 *   3. GET  /v2/plugin/auth/token?state=…       → { accessToken, refreshToken, account… }
 *
 * token 落地位置（按优先级，都试一遍，谁成谁算）：
 *   a. 环境变量 CODEBUDDY_AUTH_TOKEN —— 只在单次派活时注入，不污染全局
 *   b. ~/.codebuddy/settings.json 的 env.CODEBUDDY_AUTH_TOKEN —— 持久化，推荐
 */

const DEFAULT_BASE = 'https://copilot.tencent.com'
const PLATFORM = 'CLI'

/** 这四个头告诉服务端「别带鉴权，我要匿名申请登录态」。 */
const ANON_HEADERS = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
}

/**
 * 申请一个登录态。
 * @param {{baseUrl?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{state: string, authUrl: string, baseUrl: string}>}
 */
export async function requestLoginState(options = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/u, '')
  const timeoutMs = options.timeoutMs ?? 20000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/v2/plugin/auth/state?platform=${PLATFORM}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ANON_HEADERS },
      body: '{}',
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    const data = payload?.data
    if (data === null || data === undefined || typeof data.state !== 'string' || typeof data.authUrl !== 'string') {
      throw new Error(`申请登录态失败：HTTP ${response.status} ${payload?.msg ?? ''}`.trim())
    }
    return { state: data.state, authUrl: data.authUrl, baseUrl }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 轮询等用户把登录做完。
 * @param {object} options
 * @param {string} options.state
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{accessToken: string, refreshToken: string, account: object, payload: object}>}
 */
export async function waitForLoginToken(options) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/u, '')
  const timeoutMs = options.timeoutMs ?? 300000
  const intervalMs = options.intervalMs ?? 2500
  const deadline = Date.now() + timeoutMs
  let lastStatus = ''

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new Error('登录等待被取消')
    let response = null
    try {
      response = await fetch(`${baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(options.state)}`, {
        headers: ANON_HEADERS,
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error)
      await sleep(intervalMs)
      continue
    }
    const payload = await response.json().catch(() => null)
    const data = payload?.data
    if (data !== null && data !== undefined) {
      const accessToken = typeof data.accessToken === 'string' ? data.accessToken : (typeof data.token === 'string' ? data.token : '')
      if (accessToken.length > 0) {
        return {
          accessToken,
          refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
          account: data.account ?? {},
          payload: data,
        }
      }
    }
    lastStatus = payload?.msg ?? `HTTP ${response.status}`
    await sleep(intervalMs)
  }
  throw new Error(`等登录超时（${Math.round(timeoutMs / 1000)}s）${lastStatus.length > 0 ? `，最后状态：${lastStatus}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { ANON_HEADERS, DEFAULT_BASE, PLATFORM }