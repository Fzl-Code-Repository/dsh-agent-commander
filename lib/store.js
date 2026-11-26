/**
 * 任务存储：一次派活 = 一个 task 记录 + 一份事件流。
 *
 * 为什么落盘：派活可能跑半小时，模型不可能一直挂着等；落盘之后
 *   - 插件重启还能查历史
 *   - 事件流可以事后完整回看（模型只看摘要）
 *   - 验收要用到「智能体到底动了哪些文件」这类执行时证据
 *
 * 目录结构：<dataDir>/tasks/<taskId>/
 *   meta.json   任务元信息与最终状态（原子写）
 *   events.jsonl 逐行事件（追加写，崩溃也不丢已发生的）
 *   stderr.log  子进程 stderr 原文
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { event } from './adapters/base.js'

/** 原子写：先写临时文件再改名，避免半截 JSON。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export class TaskStore {
  #root

  constructor(dataDir) {
    this.#root = path.join(dataDir, 'tasks')
    mkdirSync(this.#root, { recursive: true })
  }

  get root() {
    return this.#root
  }

  dirOf(taskId) {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/u.test(taskId)) {
      throw new Error(`任务 id 不合法：${String(taskId)}`)
    }
    return path.join(this.#root, taskId)
  }

  /** 建一个任务目录并把初始 meta 写进去。 */
  create(meta) {
    const dir = this.dirOf(meta.id)
    mkdirSync(dir, { recursive: true })
    writeJsonAtomic(path.join(dir, 'meta.json'), meta)
    return dir
  }

  saveMeta(taskId, meta) {
    writeJsonAtomic(path.join(this.dirOf(taskId), 'meta.json'), meta)
  }

  readMeta(taskId) {
    const file = path.join(this.dirOf(taskId), 'meta.json')
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  appendEvent(taskId, evt) {
    appendFileSync(path.join(this.dirOf(taskId), 'events.jsonl'), `${JSON.stringify(evt)}\n`, 'utf8')
  }

  /** 读事件流；fromIndex 用于增量读，limit 防止一次读爆上下文。 */
  readEvents(taskId, { fromIndex = 0, limit = 200 } = {}) {
    const file = path.join(this.dirOf(taskId), 'events.jsonl')
    if (!existsSync(file)) return { events: [], total: 0 }
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0)
    const events = []
    for (let i = fromIndex; i < lines.length && events.length < limit; i += 1) {
      try {
        events.push(JSON.parse(lines[i]))
      } catch {
        events.push({ kind: 'raw', text: lines[i] })
      }
    }
    return { events, total: lines.length }
  }

  writeStderr(taskId, text) {
    if (typeof text !== 'string' || text.length === 0) return
    appendFileSync(path.join(this.dirOf(taskId), 'stderr.log'), text, 'utf8')
  }

  /** 最近的任务，按目录名（含时间戳）倒序。 */
  listRecent(limit = 20) {
    if (!existsSync(this.#root)) return []
    const entries = readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit)
    const out = []
    for (const name of entries) {
      const meta = this.readMeta(name)
      if (meta !== undefined) out.push(meta)
    }
    return out
  }

  /** 清理过期任务目录（默认 14 天）。 */
  prune(olderThanMs = 14 * 24 * 3600 * 1000) {
    if (!existsSync(this.#root)) return 0
    const cutoff = Date.now() - olderThanMs
    let removed = 0
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.#root, entry.name)
      try {
        if (statSync(dir).mtimeMs < cutoff) removed += 1
      } catch {
        // 忽略
      }
    }
    return removed
  }
}

/**
 * 把事件流压成「给人看的一句话」与「给模型看的结构化摘要」。
 * 摘要刻意只留关键节点：init / 工具调用 / 结论，
 * thinking 与 notice 不进摘要（它们是过程噪音，原文留在 events.jsonl）。
 */
export function summarize(events) {
  const tools = []
  let init
  let result
  const says = []
  for (const evt of events) {
    if (evt.kind === 'init') init = evt
    else if (evt.kind === 'tool') tools.push({ name: evt.name, input: evt.input })
    else if (evt.kind === 'say') says.push(evt.text)
    else if (evt.kind === 'result') result = evt
  }
  return { init, tools, says, result }
}

export { writeJsonAtomic, event }