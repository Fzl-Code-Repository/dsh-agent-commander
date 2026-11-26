/**
 * 工具定义：模型看到的就是这些。
 *
 * 设计取舍：
 *   - 派活立刻返回 taskId，不阻塞（真实任务可能跑十几分钟）。
 *   - 看结果分两档：agent_status 轻（不读事件流），agent_report 重（读事件+摘要）。
 *   - 验收是独立工具 agent_verify，可以拿任意检查清单去测，与派活解耦。
 *   - agent_list 兼做「探活」：一次看清本机哪个智能体真的能用。
 */
import { formatDuration, oneLine, text } from './util.js'
import { runChecks, diffSnapshot, snapshotTree } from './verify.js'
import { summarize } from './store.js'

const AGENT_ENUM_DESCRIPTION = '智能体标识，见 agent_list 的返回'

function statusHeadline(meta) {
  const icon = meta.status === 'succeeded'
    ? '✓'
    : meta.status === 'failed'
      ? '✗'
      : meta.status === 'timeout'
        ? '⏱'
        : meta.status === 'cancelled'
          ? '⊘'
          : meta.status === 'running'
            ? '▶'
            : '·'
  const duration = meta.durationMs === null || meta.durationMs === undefined
    ? (meta.startedAt === null ? '' : ` · 已跑 ${formatDuration(Date.now() - Date.parse(meta.startedAt))}`)
    : ` · ${formatDuration(meta.durationMs)}`
  return `${icon} ${meta.agent} · ${meta.status}${duration} · ${meta.id}`
}

export function createToolDefinitions({ manager, adapters, config }) {
  const tools = []

  /* ---------------------------------------------------------------- 派活 */
  tools.push({
    name: 'agent_dispatch',
    description: [
      '把一件活交给本机的另一个智能体（Qoder CN / WorkBuddy）去做，立刻返回 taskId。',
      '',
      '什么时候用：需要别家智能体动手改文件、跑命令、装依赖，或你想让两个智能体分头干活时。',
      '派活之后用 agent_report 看进度与结论，用 agent_verify 验收，不相信它自己的「我做完了」。',
      '',
      '提示词写清楚三件事：要改哪个绝对路径、验收标准是什么、只做这一件事。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: AGENT_ENUM_DESCRIPTION },
        prompt: { type: 'string', description: '交给它的完整指令' },
        cwd: { type: 'string', description: '它工作的目录（绝对路径）。不给则用当前会话目录' },
        label: { type: 'string', description: '一句话标题，便于列表里认出来' },
        model: { type: 'string', description: '指定模型；不给用适配器默认' },
        resumeSessionId: { type: 'string', description: '续接之前的会话（Qoder CN 的 session_id）' },
      },
      required: ['agent', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          agent: { type: 'string' },
          status: { type: 'string' },
          queued: { type: 'boolean' },
          dir: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['taskId', 'agent', 'status', 'queued', 'dir', 'message'],
      },
      render: (_args, value) => text(
        `${value.queued ? '已排队' : '已派出'} → ${value.agent} · 任务 ${value.taskId}\n轨迹目录：${value.dir}\n${value.message}`,
      ),
    },
    async execute(args) {
      const agent = String(args?.agent ?? config.defaultAgent ?? '')
      const prompt = String(args?.prompt ?? '')
      if (prompt.trim().length === 0) throw new Error('agent_dispatch 需要非空的 prompt')
      const result = manager.dispatch({
        agent,
        prompt,
        cwd: typeof args?.cwd === 'string' ? args.cwd : undefined,
        label: typeof args?.label === 'string' ? args.label : undefined,
        model: typeof args?.model === 'string' ? args.model : undefined,
        resumeSessionId: typeof args?.resumeSessionId === 'string' ? args.resumeSessionId : undefined,
      })
      return {
        taskId: result.taskId,
        agent: result.agent,
        status: 'queued',
        queued: result.queued,
        dir: result.dir,
        message: result.queued
          ? '并发已满，它会在前面的任务结束后自动开始。用 agent_report 查看。'
          : '已在后台开始跑。接着用 agent_report（可加 wait）看进度，跑完用 agent_verify 验收。',
      }
    },
  })

  /* ---------------------------------------------------------------- 看状态 */
  tools.push({
    name: 'agent_status',
    description: '看一眼某个任务（或全部任务）的当前状态：跑没跑完、多久了、退出码。轻量，不读事件流。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '任务 id；不给则列出最近的几个任务' },
        limit: { type: 'number', description: '列几个，默认 10' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string' },
                agent: { type: 'string' },
                status: { type: 'string' },
                label: { type: 'string' },
                cwd: { type: 'string' },
                durationMs: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['taskId', 'agent', 'status', 'label', 'cwd', 'durationMs', 'error'],
            },
          },
          running: { type: 'number' },
          queued: { type: 'number' },
        },
        required: ['tasks', 'running', 'queued'],
      },
      render: (_args, value) => {
        const stats = manager.stats()
        const head = `并发 ${stats.running}/${stats.maxConcurrent}${stats.queued > 0 ? ` · 排队 ${stats.queued}` : ''}`
        if (value.tasks.length === 0) return text(`${head}\n没有任务记录。用 agent_dispatch 派一个。`)
        const lines = value.tasks.map((task) => {
          const duration = task.durationMs > 0 ? ` · ${formatDuration(task.durationMs)}` : ''
          return `${task.status === 'succeeded' ? '✓' : task.status === 'failed' ? '✗' : task.status === 'running' ? '▶' : '·'} ${task.taskId} · ${task.agent} · ${task.status}${duration} · ${task.label}${task.error.length > 0 ? `\n    ⚠ ${oneLine(task.error, 160)}` : ''}`
        })
        return text(`${head}\n${lines.join('\n')}`)
      },
    },
    async execute(args) {
      const stats = manager.stats()
      // 注意：DSH 的输出校验器不接受 null，缺值一律用 0 / 空串表达
      const shape = (meta) => ({
        taskId: meta.id,
        agent: meta.agent,
        status: meta.status,
        label: meta.label,
        cwd: meta.cwd,
        durationMs: Number(meta.durationMs ?? 0),
        error: meta.error ?? '',
      })
      if (typeof args?.taskId === 'string' && args.taskId.length > 0) {
        return { tasks: [shape(manager.status(args.taskId))], running: stats.running, queued: stats.queued }
      }
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(50, Number(args.limit))) : 10
      return { tasks: manager.list(limit).map(shape), running: stats.running, queued: stats.queued }
    },
  })

  /* ---------------------------------------------------------------- 看报告 */
  tools.push({
    name: 'agent_report',
    description: [
      '读一个任务的执行报告：它做了什么（工具调用序列）、说了什么、结论是什么。',
      '',
      'wait=true 会等它跑完再返回（最多等 timeoutMs），适合你已经派活、现在就想拿结果的场景。',
      '默认只读末尾若干事件，摘要里保留结论与被拒工具；要看全部细节用 agent_trace。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '任务 id' },
        wait: { type: 'boolean', description: '是否等任务结束再返回' },
        timeoutMs: { type: 'number', description: 'wait 时最多等多久，默认 120000' },
      },
      required: ['taskId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          agent: { type: 'string' },
          status: { type: 'string' },
          label: { type: 'string' },
          cwd: { type: 'string' },
          durationMs: { type: 'number' },
          sessionId: { type: 'string' },
          numTurns: { type: 'number' },
          summary: { type: 'string' },
          error: { type: 'string' },
          toolCalls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { type: 'string' }, detail: { type: 'string' } },
              required: ['name', 'detail'],
            },
          },
          lastWords: { type: 'string' },
          denials: { type: 'array', items: { type: 'string' } },
          eventCount: { type: 'number' },
          stillRunning: { type: 'boolean' },
        },
        required: ['taskId', 'agent', 'status', 'label', 'cwd', 'durationMs', 'sessionId', 'numTurns', 'summary', 'error', 'toolCalls', 'lastWords', 'denials', 'eventCount', 'stillRunning'],
      },
      render: (_args, value) => {
        const head = `${statusHeadline({ ...value, id: value.taskId })}`
        const lines = [head, `标题：${value.label}`, `目录：${value.cwd}`]
        if (value.sessionId.length > 0) lines.push(`会话：${value.sessionId}（可用 resumeSessionId 续接）`)
        if (value.numTurns > 0) lines.push(`轮次：${value.numTurns}`)
        if (value.toolCalls.length > 0) {
          lines.push('', `动作（${value.toolCalls.length}）：`)
          for (const call of value.toolCalls.slice(-14)) lines.push(`  · ${call.name}${call.detail.length > 0 ? ` — ${call.detail}` : ''}`)
          if (value.toolCalls.length > 14) lines.push(`  … 还有 ${value.toolCalls.length - 14} 个`)
        }
        if (value.denials.length > 0) lines.push('', `被拒工具：${value.denials.join(', ')}`)
        if (value.summary.length > 0) lines.push('', `它的结论：${value.summary}`)
        else if (value.lastWords.length > 0) lines.push('', `它最后说的：${value.lastWords}`)
        if (value.error.length > 0) lines.push('', `⚠ ${value.error}`)
        if (value.stillRunning) lines.push('', '还在跑。稍后再看，或用 agent_report wait=true 等它结束。')
        lines.push('', `（事件 ${value.eventCount} 条；要完整轨迹用 agent_trace）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const taskId = String(args?.taskId ?? '')
      if (taskId.length === 0) throw new Error('agent_report 需要 taskId')
      const wait = args?.wait === true || String(args?.wait) === 'true'
      const timeoutMs = Number.isFinite(args?.timeoutMs) ? Number(args.timeoutMs) : 120000
      const meta = wait ? await manager.waitFor(taskId, Math.max(1000, Math.min(900000, timeoutMs))) : manager.status(taskId)
      const { events, total } = manager.events(taskId, { limit: 4000 })
      const { tools: toolCalls, says, result } = summarize(events)

      const terminal = new Set(['succeeded', 'failed', 'timeout', 'cancelled'])
      return {
        taskId: meta.id,
        agent: meta.agent,
        status: meta.status,
        label: meta.label,
        cwd: meta.cwd,
        durationMs: Number(meta.durationMs ?? 0),
        sessionId: meta.sessionId ?? '',
        numTurns: Number(meta.numTurns ?? 0),
        summary: meta.summary ?? '',
        error: meta.error ?? '',
        toolCalls: toolCalls.map((call) => ({ name: call.name, detail: describeToolInput(call.input) })),
        lastWords: says.length > 0 ? oneLine(says[says.length - 1], 600) : '',
        denials: Array.isArray(result?.denials) ? result.denials : [],
        eventCount: total,
        stillRunning: !terminal.has(meta.status),
      }
    },
  })

  /* ---------------------------------------------------------------- 完整轨迹 */
  tools.push({
    name: 'agent_trace',
    description: '读任务的完整事件流（分页）。当摘要不够、需要看清它到底跑了什么命令、改了什么文件时用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '任务 id' },
        fromIndex: { type: 'number', description: '从第几条事件开始，默认 0' },
        limit: { type: 'number', description: '读多少条，默认 80' },
        kinds: { type: 'string', description: '只看某些类型，逗号分隔：init,thinking,say,tool,tool_result,result,notice,raw' },
      },
      required: ['taskId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          fromIndex: { type: 'number' },
          total: { type: 'number' },
          nextIndex: { type: 'number' },
          lines: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskId', 'fromIndex', 'total', 'nextIndex', 'lines'],
      },
      render: (_args, value) => {
        if (value.lines.length === 0) return text(`任务 ${value.taskId} 的第 ${value.fromIndex} 条之后没有匹配的事件（共 ${value.total} 条）。`)
        const more = value.nextIndex < value.total ? `\n… 还有 ${value.total - value.nextIndex} 条，下次 fromIndex=${value.nextIndex}` : ''
        return text(`任务 ${value.taskId} 的事件 ${value.fromIndex}–${value.nextIndex - 1} / 共 ${value.total} 条\n\n${value.lines.join('\n')}${more}`)
      },
    },
    async execute(args) {
      const taskId = String(args?.taskId ?? '')
      if (taskId.length === 0) throw new Error('agent_trace 需要 taskId')
      const fromIndex = Number.isFinite(args?.fromIndex) ? Math.max(0, Math.floor(Number(args.fromIndex))) : 0
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(500, Math.floor(Number(args.limit)))) : 80
      const wanted = typeof args?.kinds === 'string' && args.kinds.length > 0
        ? new Set(args.kinds.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
        : undefined
      const { events, total } = manager.events(taskId, { limit: 20000 })
      const lines = []
      let index = fromIndex
      while (index < events.length && lines.length < limit) {
        const evt = events[index]
        index += 1
        if (wanted !== undefined && !wanted.has(evt.kind)) continue
        lines.push(formatEvent(index - 1, evt))
      }
      return { taskId, fromIndex, total, nextIndex: index, lines }
    },
  })

  /* ---------------------------------------------------------------- 验收 */
  tools.push({
    name: 'agent_verify',
    description: [
      '用证据验收一件活到底有没有干成。不听智能体的自述，只看文件、命令、git 的真实状态。',
      '',
      '检查类型（checks 数组里每项一个 kind）：',
      '  file    {kind:"file", path, contains?, matches?, minBytes?, maxBytes?}  文件存在且内容符合',
      '  absent  {kind:"absent", path}                                          该删的确实不在',
      '  command {kind:"command", command, expectExitCode?, contains?, timeoutMs?} 跑命令看退出码/输出',
      '  git     {kind:"git", repo?, clean?, hasCommit?, messageContains?, branch?} git 状态',
      '  tree    {kind:"tree", path?, pattern?, minCount?}                       目录里有预期的东西',
      '',
      '不给 checks 时，会用任务记录的工作目录做一次「这段时间新增/改了哪些文件」的证据快照。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '要验收的任务 id；给了就自动用它记录的工作目录' },
        cwd: { type: 'string', description: '检查的相对路径基准目录；不给则用任务的 cwd' },
        checks: {
          type: 'array',
          description: '检查清单',
          items: { type: 'object', additionalProperties: true, properties: { kind: { type: 'string' } }, required: ['kind'] },
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          passed: { type: 'number' },
          total: { type: 'number' },
          cwd: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string' },
                ok: { type: 'boolean' },
                detail: { type: 'string' },
                evidence: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'ok', 'detail', 'evidence'],
            },
          },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { path: { type: 'string' }, change: { type: 'string' }, size: { type: 'number' } },
              required: ['path', 'change', 'size'],
            },
          },
          note: { type: 'string' },
        },
        required: ['ok', 'passed', 'total', 'cwd', 'results', 'changes', 'note'],
      },
      render: (_args, value) => {
        const lines = [value.total === 0
          ? `${value.ok ? '✓' : '·'} 没有条款，只做了一次快照`
          : `${value.ok ? '✓ 全部通过' : '✗ 未通过'} · ${value.passed}/${value.total}`]
        lines.push(`目录：${value.cwd}`)
        for (const item of value.results) {
          lines.push('', `${item.ok ? '✓' : '✗'} [${item.kind}] ${item.detail}`)
          for (const line of item.evidence.slice(0, 6)) lines.push(`    ${line.replace(/\n/gu, '\n    ')}`)
        }
        if (value.changes.length > 0) {
          lines.push('', `这段期间的改动（${value.changes.length}）：`)
          for (const change of value.changes.slice(0, 30)) lines.push(`  ${change.change === 'added' ? '+' : change.change === 'changed' ? '~' : '-'} ${change.path}`)
          if (value.changes.length > 30) lines.push(`  … 还有 ${value.changes.length - 30} 项`)
        }
        if (value.note.length > 0) lines.push('', value.note)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const taskId = typeof args?.taskId === 'string' && args.taskId.length > 0 ? args.taskId : undefined
      let cwd = typeof args?.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined
      let meta
      if (taskId !== undefined) {
        meta = manager.status(taskId)
        cwd ??= meta.cwd
      }
      cwd ??= process.cwd()

      const checks = Array.isArray(args?.checks) ? args.checks : []
      // 有 taskId 且带 cwd 时做个文件快照，让「它到底动了什么」有据可查
      let changes = []
      if (taskId !== undefined && checks.length === 0) {
        const after = snapshotTree(cwd)
        const before = new Map()
        // 没有历史快照时，退化成「列出当前目录里最近改动的文件」
        for (const entry of after.values()) {
          if (entry.mtimeMs >= Date.parse(meta.createdAt)) before.set(entry.path, entry)
        }
        changes = [...before.values()]
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 100)
          .map((entry) => ({ path: entry.path, change: 'changed', size: entry.size }))
      }

      const outcome = await runChecks({ cwd, checks })
      let note = ''
      if (checks.length > 0 && outcome.ok) note = '全部条款通过。'
      else if (checks.length > 0) note = '有条款没通过；看上面的证据判断是智能体没做完，还是条款写得太死。'
      else if (changes.length > 0) note = `无条款模式：${cwd} 下自任务开始后有 ${changes.length} 个文件被改动（按修改时间倒序）。要严格验收请传 checks。`
      else note = '无条款模式：这期间没有发现文件改动。若任务本应改文件，那基本可以判定它没干成。'

      return {
        ok: outcome.ok,
        passed: outcome.passed,
        total: outcome.total,
        cwd,
        results: outcome.results.map((item) => ({
          kind: item.kind,
          ok: item.ok,
          detail: item.detail,
          evidence: item.evidence.slice(0, 8),
        })),
        changes,
        note,
      }
    },
  })

  /* ---------------------------------------------------------------- 取消 */
  tools.push({
    name: 'agent_cancel',
    description: '取消一个还在跑的任务（先 SIGTERM，宽限后强杀）。已经结束的任务不能取消。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '任务 id' },
        reason: { type: 'string', description: '取消原因，会写进任务记录' },
      },
      required: ['taskId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { taskId: { type: 'string' }, cancelled: { type: 'boolean' }, message: { type: 'string' } },
        required: ['taskId', 'cancelled', 'message'],
      },
      render: (_args, value) => text(value.cancelled ? `已取消 ${value.taskId}：${value.message}` : `未取消 ${value.taskId}：${value.message}`),
    },
    async execute(args) {
      const taskId = String(args?.taskId ?? '')
      if (taskId.length === 0) throw new Error('agent_cancel 需要 taskId')
      const reason = typeof args?.reason === 'string' && args.reason.length > 0 ? args.reason : '用户取消'
      try {
        const result = manager.cancel(taskId, reason)
        return { taskId, cancelled: result.cancelled, message: reason }
      } catch (error) {
        return { taskId, cancelled: false, message: String(error instanceof Error ? error.message : error) }
      }
    },
  })

  /* ---------------------------------------------------------------- 探活/清单 */
  tools.push({
    name: 'agent_list',
    description: [
      '列出本机能指挥的智能体，以及它们的真实可用状态（装没装、登录没登录）。',
      '派活前先看一眼，别把活派给一个没登录的智能体。',
    ].join('\n'),
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          adapters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                available: { type: 'boolean' },
                loggedIn: { type: 'boolean' },
                binary: { type: 'string' },
                version: { type: 'string' },
                detail: { type: 'string' },
              },
              required: ['id', 'label', 'available', 'loggedIn', 'binary', 'version', 'detail'],
            },
          },
          defaultAgent: { type: 'string' },
        },
        required: ['adapters', 'defaultAgent'],
      },
      render: (_args, value) => {
        const lines = value.adapters.map((item) => {
          const flag = item.available ? (item.loggedIn === false ? '⚠' : '✓') : '✗'
          const version = item.version.length > 0 ? ` · ${item.version}` : ''
          return `${flag} ${item.id}（${item.label}）${version}\n    ${item.detail}`
        })
        return text(`${lines.join('\n')}\n\n默认派给：${value.defaultAgent}`)
      },
    },
    async execute() {
      const results = []
      for (const adapter of adapters.list()) {
        let probe
        try {
          probe = await adapter.probe()
        } catch (error) {
          probe = { available: false, loggedIn: false, binary: '', detail: `探测失败：${String(error)}` }
        }
        results.push({
          id: adapter.id,
          label: adapter.label,
          available: probe.available === true,
          // 注意：DSH 的输出校验器不接受 null —— 未知就是 false / 空串
          loggedIn: probe.loggedIn === true,
          binary: probe.binary ?? '',
          version: probe.version ?? '',
          detail: probe.detail ?? '',
        })
      }
      return { adapters: results, defaultAgent: String(config.defaultAgent ?? 'qoder-cn') }
    },
  })

  return tools
}

/** 把工具入参压成一句人能读的摘要（只挑最有信息量的字段）。 */
function describeToolInput(input) {
  if (input === null || typeof input !== 'object') return ''
  const priority = ['command', 'file_path', 'path', 'pattern', 'description', 'prompt', 'url']
  for (const key of priority) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return oneLine(value, 160)
  }
  const first = Object.values(input).find((value) => typeof value === 'string' && value.length > 0)
  return typeof first === 'string' ? oneLine(first, 160) : ''
}

/** 把一条事件格式化成轨迹里的一行。 */
function formatEvent(index, evt) {
  const prefix = `#${String(index).padStart(3, '0')}`
  switch (evt.kind) {
    case 'init':
      return `${prefix} init · ${evt.model ?? '?'} · ${evt.permissionMode ?? '?'} · ${evt.cwd ?? ''}`
    case 'thinking':
      return `${prefix} think · ${oneLine(evt.text, 300)}`
    case 'say':
      return `${prefix} say · ${oneLine(evt.text, 500)}`
    case 'tool':
      return `${prefix} tool · ${evt.name} ${oneLine(describeToolInput(evt.input), 300)}`
    case 'tool_result':
      return `${prefix} ${evt.ok ? 'ok' : 'err'} · ${oneLine(evt.text, 300)}`
    case 'result':
      return `${prefix} result · ${evt.ok ? 'success' : 'failure'} · ${oneLine(evt.summary ?? '', 400)}`
    case 'notice':
      return `${prefix} notice · ${oneLine(evt.text, 200)}`
    case 'dispatch':
      return `${prefix} spawn · ${evt.binary} ${(evt.args ?? []).join(' ')}`.slice(0, 400)
    case 'finish':
      return `${prefix} finish · ${evt.status}`
    case 'credits':
      return `${prefix} usage · ${evt.total ?? '?'} credits · 上下文 ${evt.contextRatio === undefined ? '?' : `${Math.round(evt.contextRatio * 100)}%`}`
    default:
      return `${prefix} ${evt.kind} · ${oneLine(typeof evt.text === 'string' ? evt.text : JSON.stringify(evt), 300)}`
  }
}