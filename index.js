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

  ctx.logger?.info?.(`agent-commander 就绪：可指挥 ${adapters.ids().join('、')}`)
}

export { SessionManager, AdapterRegistry, createToolDefinitions }