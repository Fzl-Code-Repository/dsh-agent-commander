/** 通用小工具：限流截断、时间、安全的 JSON 读取、渲染辅助。 */

export function text(value) {
  return [{ type: 'text', text: String(value) }]
}

export function nowIso() {
  return new Date().toISOString()
}

/** 按字节上限截断字符串，保留头尾，中间标注省略了多少。 */
export function clipBytes(value, maxBytes, label = '内容') {
  const s = typeof value === 'string' ? value : String(value ?? '')
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  const half = Math.max(1, Math.floor(maxBytes / 2))
  const head = buf.subarray(0, half).toString('utf8')
  const tail = buf.subarray(buf.length - half).toString('utf8')
  return `${head}\n…[${label}已截断：原始 ${buf.length} 字节，保留头尾各约 ${half} 字节]…\n${tail}`
}

/** 单行化 + 限长，用于把工具输出塞进紧凑摘要。 */
export function oneLine(value, maxChars = 400) {
  const s = typeof value === 'string' ? value : String(value ?? '')
  const flat = s.replace(/\s+/gu, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars)}…`
}

export function shortenPath(value, maxChars = 72) {
  const s = String(value ?? '')
  if (s.length <= maxChars) return s
  return `…${s.slice(s.length - maxChars + 1)}`
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s}s`
  const h = Math.floor(m / 60)
  if (h === 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function safeJsonParse(value, fallback = undefined) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** 把任意错误整理成一句可读的话。 */
export function errorText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

/** 去重但保序。 */
export function unique(list) {
  return [...new Set(list)]
}

/** 宽松的布尔参数解析（模型有时传字符串）。 */
export function asBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(s)) return false
  }
  if (typeof value === 'number') return value !== 0
  return fallback
}

export function asStringArray(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length > 0)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

/** 生成任务 id：时间前缀 + 短随机，方便按名字排序与人工辨认。 */
export function makeTaskId(prefix = 'task') {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/gu, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${stamp}-${rand}`
}

/**
 * 给一个 promise 加超时上限。
 *
 * 注意：内部的定时器**绝不 unref** —— unref 过的定时器不撑事件循环，
 * Node 会认为「没事可做」而在 await 上直接退出，调用方永远等不到结果。
 * 这是本插件踩过的坑，别改回去。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} [fallback] 超时后返回什么；不给就抛错
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, fallback = undefined) {
  if (!(ms > 0)) return promise
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (fallback !== undefined) resolve(fallback)
      else reject(new Error(`超时：等了 ${Math.round(ms / 1000)} 秒`))
    }, ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}