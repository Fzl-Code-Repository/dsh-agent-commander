/**
 * 适配器基类 + 注册表。
 *
 * 一个适配器 = 「一种可以被指挥的智能体」。它只负责三件事：
 *   1. probe()   —— 本机是否可用、二进制在哪、登录了没有
 *   2. build()   —— 把一次派活翻译成具体的命令行 argv
 *   3. parse()   —— 把该 CLI 的每行输出翻译成统一事件
 *
 * 统一事件（adapter 层的唯一契约）：
 *   { kind: 'init',    sessionId?, model?, cwd?, tools?, permissionMode? }
 *   { kind: 'thinking', text }
 *   { kind: 'say',     text }            // 智能体对用户说的话
 *   { kind: 'tool',    name, input, id } // 要动手了
 *   { kind: 'tool_result', id?, ok, text }
 *   { kind: 'credits', total, contextRatio }
 *   { kind: 'notice',  text }            // 噪音/告警（默认不进摘要）
 *   { kind: 'result',  ok, summary, numTurns, durationMs, sessionId, credits, denials[] }
 *   { kind: 'raw',     text }            // 解析不了的行，原样保留
 */

/** 适配器必须实现的接口（用作文档与运行时校验）。 */
export const ADAPTER_INTERFACE = Object.freeze({
  id: '适配器标识，等同配置里的 key',
  label: '人看的名字',
  async probe() { throw new Error('probe() 未实现') },
  build() { throw new Error('build() 未实现') },
  parse() { throw new Error('parse() 未实现') },
})

export class AdapterRegistry {
  #adapters = new Map()

  register(adapter) {
    if (adapter === null || typeof adapter !== 'object') throw new Error('适配器必须是对象')
    if (typeof adapter.id !== 'string' || adapter.id.length === 0) throw new Error('适配器缺少 id')
    for (const method of ['probe', 'build', 'parse']) {
      if (typeof adapter[method] !== 'function') throw new Error(`适配器 ${adapter.id} 缺少 ${method}() 方法`)
    }
    this.#adapters.set(adapter.id, adapter)
    return adapter
  }

  get(id) {
    return this.#adapters.get(id)
  }

  has(id) {
    return this.#adapters.has(id)
  }

  ids() {
    return [...this.#adapters.keys()]
  }

  list() {
    return [...this.#adapters.values()]
  }
}

/**
 * 生成统一事件的工厂，避免各处写错字段名。
 */
export const event = {
  init: (fields = {}) => ({ kind: 'init', ...fields }),
  thinking: (text) => ({ kind: 'thinking', text }),
  say: (text) => ({ kind: 'say', text }),
  tool: (name, input, id) => ({ kind: 'tool', name, input, id }),
  toolResult: (id, ok, text) => ({ kind: 'tool_result', id, ok, text }),
  credits: (total, contextRatio) => ({ kind: 'credits', total, contextRatio }),
  notice: (text) => ({ kind: 'notice', text }),
  result: (fields = {}) => ({ kind: 'result', ok: Boolean(fields.ok), ...fields }),
  raw: (text) => ({ kind: 'raw', text }),
}