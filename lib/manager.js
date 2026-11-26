/**
 * 会话管理器：派活、跟踪、取消。
 *
 * 一次派活的生命周期：
 *   queued → running → (succeeded | failed | timeout | cancelled)
 *
 * 关键设计：派活在**后台**跑，工具立刻返回 taskId。
 * 因为一个真实任务可能跑十几分钟，模型不该挂在那里等；
 * 需要结果就用 agent_report 轮询（它会把长轮询压成一次等待）。
 */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { runStreaming } from './runner.js'
import { TaskStore } from './store.js'
import { errorText, makeTaskId, nowIso, oneLine } from './util.js'

/** 一次任务在内存里的活动状态（不落盘的部分）。 */
class LiveTask {
  constructor(meta) {
    this.meta = meta
    this.childDone = undefined
    this.abortController = new AbortController()
    this.events = []
    this.listeners = new Set()
  }

  push(evt) {
    this.events.push(evt)
    for (const listener of this.listeners) listener(evt)
  }
}

export class SessionManager {
  #store
  #adapters
  #config
  #live = new Map()
  #queue = []
  #running = 0

  constructor({ dataDir, adapters, config }) {
    this.#config = config ?? {}
    this.#adapters = adapters
    this.#store = new TaskStore(dataDir)
    mkdirSync(dataDir, { recursive: true })
  }

  get store() {
    return this.#store
  }

  get dataDir() {
    return path.dirname(this.#store.root)
  }

  /** 当前并发与排队情况，给 agent_status 用。 */
  stats() {
    return { running: this.#running, queued: this.#queue.length, maxConcurrent: this.#maxConcurrent() }
  }

  #maxConcurrent() {
    const value = Number(this.#config.maxConcurrent)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3
  }

  /**
   * 派活。立刻返回 taskId，实际执行在后台。
   * @returns {{ taskId: string, agent: string, dir: string, queued: boolean }}
   */
  dispatch({ agent, prompt, cwd, model, resumeSessionId, extraArgs, label, verify, timeoutMs }) {
    const adapter = this.#adapters.get(agent)
    if (adapter === undefined) {
      throw new Error(`未知的智能体 ${agent}；可用：${this.#adapters.ids().join(', ')}`)
    }
    const taskId = makeTaskId(agent)
    const meta = {
      id: taskId,
      agent,
      label: typeof label === 'string' && label.length > 0 ? label : oneLine(prompt, 60),
      prompt,
      cwd: cwd ?? process.cwd(),
      model: model ?? null,
      resumeSessionId: resumeSessionId ?? null,
      status: 'queued',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      durationMs: null,
      sessionId: null,
      numTurns: null,
      summary: null,
      error: null,
      verify: verify ?? null,
      result: null,
    }
    this.#store.create(meta)
    const live = new LiveTask(meta)
    this.#live.set(taskId, live)
    this.#queue.push({ taskId, adapter, task: { prompt, cwd, model, resumeSessionId, extraArgs, timeoutMs } })
    queueMicrotask(() => this.#pump())
    return { taskId, agent, dir: this.#store.dirOf(taskId), queued: this.#running >= this.#maxConcurrent() }
  }

  #pump() {
    while (this.#running < this.#maxConcurrent() && this.#queue.length > 0) {
      const next = this.#queue.shift()
      this.#running += 1
      void this.#runOne(next).finally(() => {
        this.#running -= 1
        queueMicrotask(() => this.#pump())
      })
    }
  }

  async #runOne({ taskId, adapter, task }) {
    const live = this.#live.get(taskId)
    if (live === undefined) return
    const meta = live.meta
    meta.status = 'running'
    meta.startedAt = nowIso()
    this.#store.saveMeta(taskId, meta)

    let invocation
    try {
      invocation = adapter.build(task)
    } catch (error) {
      meta.status = 'failed'
      meta.error = `无法构造命令：${errorText(error)}`
      meta.finishedAt = nowIso()
      this.#store.saveMeta(taskId, meta)
      return
    }

    const record = (evt) => {
      this.#store.appendEvent(taskId, evt)
      live.push(evt)
      if (evt.kind === 'init' && typeof evt.sessionId === 'string') meta.sessionId = evt.sessionId
      if (evt.kind === 'result') meta.result = evt
    }

    record({ kind: 'dispatch', at: nowIso(), binary: invocation.binary, args: invocation.args, cwd: invocation.cwd ?? null })

    const outcome = await runStreaming({
      binary: invocation.binary,
      args: invocation.args,
      cwd: invocation.cwd,
      timeoutMs: invocation.timeoutMs ?? this.#config.timeoutMs ?? 1800000,
      graceMs: invocation.graceMs ?? this.#config.graceMs ?? 5000,
      signal: live.abortController.signal,
      onStdoutLine: (line) => {
        for (const evt of adapter.parse(line)) record(evt)
      },
      onStderrLine: (line) => {
        this.#store.writeStderr(taskId, `${line}\n`)
      },
    })

    meta.exitCode = outcome.exitCode
    meta.durationMs = outcome.durationMs
    meta.finishedAt = nowIso()

    const result = meta.result
    if (outcome.timedOut) {
      meta.status = 'timeout'
      meta.error = `超过 ${Math.round((invocation.timeoutMs ?? this.#config.timeoutMs ?? 0) / 1000)}s 未完成，已被终止`
    } else if (outcome.aborted) {
      meta.status = 'cancelled'
      meta.error = '被调用方取消'
    } else if (result !== null && result !== undefined) {
      meta.status = result.ok ? 'succeeded' : 'failed'
      meta.summary = result.summary ?? null
      meta.numTurns = result.numTurns ?? null
      if (!result.ok) {
        const denials = Array.isArray(result.denials) && result.denials.length > 0
          ? `；被拒工具：${result.denials.join(', ')}`
          : ''
        meta.error = `智能体报告失败（${result.subtype ?? 'unknown'}${denials}）`
      }
    } else if (outcome.spawnError !== undefined) {
      meta.status = 'failed'
      meta.error = `启动失败：${outcome.spawnError}`
    } else if (outcome.exitCode === 0) {
      // 有 CLI 不吐 result 事件也不算失败；用退出码兜底
      meta.status = 'succeeded'
      meta.summary = null
    } else {
      meta.status = 'failed'
      const tail = outcome.stderr.trim().split('\n').slice(-6).join('\n')
      meta.error = `退出码 ${outcome.exitCode}${tail.length > 0 ? `\n${tail}` : ''}`
    }

    this.#store.saveMeta(taskId, meta)
    record({ kind: 'finish', at: nowIso(), status: meta.status })
  }

  /** 取消一个正在跑的任务。 */
  cancel(taskId, reason = '用户取消') {
    const live = this.#live.get(taskId)
    if (live === undefined) throw new Error(`任务 ${taskId} 不在本会话的活动列表里（可能已经结束）`)
    live.abortController.abort()
    live.meta.error = reason
    this.#store.saveMeta(taskId, live.meta)
    return { taskId, cancelled: true }
  }

  /** 读一次状态（不等待）。 */
  status(taskId) {
    const meta = this.#store.readMeta(taskId)
    if (meta === undefined) throw new Error(`找不到任务 ${taskId}`)
    return meta
  }

  /** 增量读事件，给报告用。 */
  events(taskId, options) {
    return this.#store.readEvents(taskId, options)
  }

  list(limit = 20) {
    return this.#store.listRecent(limit)
  }

  /**
   * 等一个任务结束（或等到 timeoutMs）。
   * 用于 agent_report 的 wait 模式：模型说「等它跑完」时不必自己轮询。
   */
  async waitFor(taskId, timeoutMs) {
    const meta = this.#store.readMeta(taskId)
    if (meta === undefined) throw new Error(`找不到任务 ${taskId}`)
    const terminal = new Set(['succeeded', 'failed', 'timeout', 'cancelled'])
    if (terminal.has(meta.status)) return meta

    const deadline = Date.now() + Math.max(0, timeoutMs)
    return new Promise((resolve) => {
      let timer = null
      const tick = () => {
        const current = this.#store.readMeta(taskId)
        if (current !== undefined && terminal.has(current.status)) {
          if (timer !== null) clearInterval(timer)
          resolve(current)
        }
      }
      timer = setInterval(tick, 500)
      timer.unref?.()
      setTimeout(() => {
        if (timer !== null) clearInterval(timer)
        resolve(this.#store.readMeta(taskId) ?? meta)
      }, Math.max(0, deadline - Date.now())).unref?.()
    })
  }
}