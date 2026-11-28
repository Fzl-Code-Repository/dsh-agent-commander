/**
 * dsh-agent-commander —— 指挥本机的别的智能体干活。
 *
 * 分工：
 *   - 我是指挥者：拆活、派人、看进度、验收。
 *   - Qoder CN / WorkBuddy 是执行者：真的动手改文件、跑命令。
 *
 * 工具体系（六个）：
 *   agent_list     本机能指挥谁、谁真能用
 *   agent_dispatch 派活（立刻返回 taskId，后台跑）
 *   agent_status   看状态（轻量）
 *   agent_report   看报告（等到跑完 + 摘要）
 *   agent_trace    看完整轨迹（分页）
 *   agent_verify   用证据验收
 *   agent_cancel   取消
 *
 * 为什么这样切：真实任务动辄跑十几分钟，派活必须是非阻塞的；
 * 而「验收」必须是独立于执行者自述的第二方证据。
 */
import { AdapterRegistry } from './lib/adapters/base.js'
import { createQoderCnAdapter } from './lib/adapters/qoder-cn.js'
import { createWorkBuddyAdapter } from './lib/adapters/workbuddy.js'
import { SessionManager } from './lib/manager.js'
import { createToolDefinitions } from './lib/tools.js'
import { dataDir } from './lib/paths.js'
import { startConsole } from './lib/console.js'

export const name = 'agent-commander'
export const inject = ['tools']

export const DEFAULT_CONFIG = {
  defaultAgent: 'qoder-cn',
  timeoutMs: 1800000,
  graceMs: 5000,
  maxEventBytes: 120000,
  maxConcurrent: 3,
  autoVerify: true,
  adapters: {
    'qoder-cn': { enabled: true, binary: '', permissionMode: 'bypass_permissions', model: '', allowedCwd: [] },
    workbuddy: { enabled: true, binary: '', permissionMode: 'bypassPermissions', model: '', allowedCwd: [] },
  },
  console: { enabled: true, port: 4790, recentTasks: 30 },
}

/** 合并用户配置与默认值（浅合并到 adapters 一层）。 */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...input, adapters: { ...DEFAULT_CONFIG.adapters } }
  if (input.adapters !== null && typeof input.adapters === 'object') {
    for (const [key, value] of Object.entries(input.adapters)) {
      merged.adapters[key] = { ...(DEFAULT_CONFIG.adapters[key] ?? {}), ...(value ?? {}) }
    }
  }
  return merged
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  const adapters = new AdapterRegistry()
  if (config.adapters['qoder-cn']?.enabled !== false) {
    adapters.register(createQoderCnAdapter(config.adapters['qoder-cn'], config))
  }
  if (config.adapters.workbuddy?.enabled !== false) {
    adapters.register(createWorkBuddyAdapter(config.adapters.workbuddy, config))
  }

  const manager = new SessionManager({
    dataDir: dataDir(config),
    adapters,
    config,
  })

  const definitions = createToolDefinitions({ manager, adapters, config })
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  // 控制台：把「派了几单、跑到哪一步、验收过没过」变成看得见的一页。
  // 启不来（端口被占满、页面文件缺失）绝不能把工具一起拖死 —— 只告警，其余照旧。
  if (config.console?.enabled !== false) {
    ctx.effect(() => {
      let handle = null
      let closed = false
      startConsole({ manager, adapters, config })
        .then((started) => {
          if (!started) return
          if (closed) { started.close?.(); return }
          handle = started
          ctx.logger?.info?.(`agent-commander 控制台：${started.url}`)
        })
        .catch((error) => {
          ctx.logger?.warn?.(`agent-commander 控制台没起来（工具不受影响）：${error?.message ?? error}`)
        })
      return () => {
        closed = true
        handle?.close?.()
        handle = null
      }
    })
  }

  ctx.logger?.info?.(`agent-commander 就绪：可指挥 ${adapters.ids().join('、')}`)
}

export { SessionManager, AdapterRegistry, createToolDefinitions }