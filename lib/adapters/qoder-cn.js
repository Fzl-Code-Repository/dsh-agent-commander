/**
 * Qoder CN 适配器。
 *
 * 驱动方式：`qoderclicn` 无头模式（-p / --output-format stream-json）。
 * 实测要点（2026-11，qoderclicn 1.1.95）：
 *   - `--permission-mode bypass_permissions` 才能无人值守改文件；
 *     `dont_ask` 会静默拒绝一切写操作（返回 "This action needs approval..."），
 *     所以本适配器默认永远不用 dont_ask。
 *   - 流式事件格式与 Claude Code 同源，解析走 claude-style.js。
 *   - 会话续接：`-r <session_id>`。
 *   - 每次调用都会打印 `Skipped invalid MCP server "mx-ds-mcp"` 告警，纯噪音，归到 notice。
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { runCapture } from '../runner.js'
import { expandHome } from '../paths.js'
import { oneLine, safeJsonParse } from '../util.js'
import { parseClaudeStyleLine } from './claude-style.js'

const DEFAULT_BINARY = path.join(os.homedir(), '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe')

export function createQoderCnAdapter(adapterConfig, globalConfig) {
  const config = adapterConfig ?? {}
  const binary = typeof config.binary === 'string' && config.binary.length > 0
    ? expandHome(config.binary)
    : DEFAULT_BINARY

  return {
    id: 'qoder-cn',
    label: 'Qoder CN',
    defaultBinary: DEFAULT_BINARY,

    async probe() {
      if (!existsSync(binary)) {
        return {
          available: false,
          binary,
          loggedIn: false,
          detail: `找不到 qoderclicn：${binary}。请安装 Qoder CN，或在此适配器的 binary 里填可执行文件路径。`,
        }
      }
      const [version, status] = await Promise.all([
        runCapture({ binary, args: ['--version'], timeoutMs: 30000 }),
        runCapture({ binary, args: ['status', '-o', 'json'], timeoutMs: 45000 }),
      ])
      const statusJson = safeJsonParse(status.stdout.trim(), undefined)
      const loggedIn = statusJson?.logged_in === true
      const parts = []
      const versionLine = version.ok ? version.stdout.trim().split('\n')[0] : undefined
      parts.push(versionLine !== undefined && versionLine.length > 0 ? `版本 ${versionLine}` : '版本未知')
      if (loggedIn) {
        parts.push(`已登录 ${statusJson.username ?? ''}`.trim())
      } else {
        parts.push('未登录（跑一次 `qoderclicn login` 扫码）')
      }
      return {
        available: true,
        binary,
        version: versionLine,
        loggedIn,
        account: loggedIn ? String(statusJson.username ?? '') : undefined,
        detail: parts.join(' · '),
      }
    },

    build(task) {
      const args = ['-p', '--output-format', 'stream-json']
      const permissionMode = typeof config.permissionMode === 'string' && config.permissionMode.length > 0
        ? config.permissionMode
        : 'bypass_permissions'
      args.push('--permission-mode', permissionMode)
      const model = task.model ?? config.model
      if (typeof model === 'string' && model.length > 0) args.push('--model', model)
      if (typeof task.cwd === 'string' && task.cwd.length > 0) args.push('--cwd', task.cwd)
      if (typeof task.resumeSessionId === 'string' && task.resumeSessionId.length > 0) args.push('-r', task.resumeSessionId)
      if (Array.isArray(task.extraArgs)) args.push(...task.extraArgs)
      args.push('--', task.prompt)
      return {
        binary,
        args,
        cwd: task.cwd ?? config.cwd ?? undefined,
        timeoutMs: task.timeoutMs ?? globalConfig?.timeoutMs,
        graceMs: globalConfig?.graceMs,
      }
    },

    parse(line) {
      return parseClaudeStyleLine(line)
    },

    /** 登录指引：这个适配器需要人扫码，所以给一句能直接抄的话。 */
    loginHint() {
      return `在终端跑一次 "${binary}" login，浏览器里选账号授权；授权完 status -o json 会显示 logged_in: true。`
    },

    loginCommand() {
      return { binary, args: ['login'] }
    },
  }
}

export { DEFAULT_BINARY as QODER_DEFAULT_BINARY, oneLine }