/**
 * WorkBuddy 适配器。
 *
 * 驱动方式：WorkBuddy 桌面端本身**自带**一份 codebuddy CLI
 *   <安装目录>/resources/app.asar.unpacked/cli/bin/codebuddy
 * 直接用它，比另装 npm 包可靠：版本与桌面端一致，登录态也共用。
 *
 * 实测要点（WorkBuddy 5.5.4 自带 codebuddy 2.137.1）：
 *   - 它不一定是 .exe，而是 node 脚本，所以要用本机 node 去跑（argv0 = node，argv1 = 脚本）。
 *   - `--permission-mode bypassPermissions`（驼峰）才能全自主；可选 acceptEdits/default/plan/dontAsk/auto。
 *   - `--output-format stream-json` 与 Qoder CN 同源格式（都源自 Claude Code 协议），
 *     因此解析器与 qoder-cn 共用一套逻辑。
 *   - 会自动下载/使用自己的运行时，首次启动稍慢。
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { runCapture } from '../runner.js'
import { event } from './base.js'
import { expandHome } from '../paths.js'
import { oneLine, safeJsonParse } from '../util.js'
import { parseClaudeStyleLine, NODE_BIN } from './claude-style.js'

const INSTALL_ROOTS = [
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WorkBuddy'),
  path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'WorkBuddy'),
]

/** 在若干候选位置里找 WorkBuddy 自带的 codebuddy CLI。 */
function findBundledCli() {
  const relative = path.join('resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
  for (const root of INSTALL_ROOTS) {
    const candidate = path.join(root, relative)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function createWorkBuddyAdapter(adapterConfig, globalConfig) {
  const config = adapterConfig ?? {}
  const configuredBinary = typeof config.binary === 'string' && config.binary.length > 0
    ? expandHome(config.binary)
    : undefined

  return {
    id: 'workbuddy',
    label: 'WorkBuddy',
    defaultBinary: findBundledCli(),

    async probe() {
      const binary = configuredBinary ?? findBundledCli()
      if (binary === undefined) {
        return {
          available: false,
          binary: '',
          loggedIn: false,
          detail: '找不到 WorkBuddy。装好 WorkBuddy 桌面端后它会自带 codebuddy CLI；也可以在此适配器的 binary 里指向任意 codebuddy 可执行文件。',
        }
      }
      // node 脚本要用本机 node 跑；.exe 直接跑
      const isScript = !/\.exe$/iu.test(binary)
      const nodeBin = NODE_BIN()
      const invocation = isScript
        ? { binary: nodeBin, args: [binary, '--version'] }
        : { binary, args: ['--version'] }
      const version = await runCapture({ ...invocation, timeoutMs: 120000 })

      const parts = []
      if (version.ok) {
        const first = version.stdout.trim().split('\n').filter((line) => line.length > 0)[0] ?? ''
        parts.push(`版本 ${first}`)
      } else {
        parts.push('版本未知')
        if (version.spawnError !== undefined) parts.push(oneLine(version.spawnError, 120))
      }
      return {
        available: true,
        binary,
        version: version.ok ? version.stdout.trim().split('\n')[0] : undefined,
        // codebuddy 的登录态藏在 ~/.codebuddy 里，探测不打扰它，让首轮任务自己暴露
        loggedIn: undefined,
        scriptMode: isScript,
        detail: parts.join(' · '),
      }
    },

    build(task) {
      const binary = configuredBinary ?? findBundledCli()
      if (binary === undefined) throw new Error('找不到 WorkBuddy 的 codebuddy CLI；请安装 WorkBuddy 或在适配器配置里指定 binary')
      const isScript = !/\.exe$/iu.test(binary)

      const args = ['-p', '--output-format', 'stream-json']
      const permissionMode = typeof config.permissionMode === 'string' && config.permissionMode.length > 0
        ? config.permissionMode
        : 'bypassPermissions'
      args.push('--permission-mode', permissionMode)
      const model = task.model ?? config.model
      if (typeof model === 'string' && model.length > 0) args.push('--model', model)
      if (typeof task.resumeSessionId === 'string' && task.resumeSessionId.length > 0) {
        args.push('-r', task.resumeSessionId)
      }
      if (Array.isArray(task.extraArgs)) args.push(...task.extraArgs)
      args.push('--', task.prompt)

      return {
        binary: isScript ? NODE_BIN() : binary,
        args: isScript ? [binary, ...args] : args,
        cwd: task.cwd ?? config.cwd ?? undefined,
        timeoutMs: globalConfig?.timeoutMs,
        graceMs: globalConfig?.graceMs,
      }
    },

    parse(line) {
      return parseClaudeStyleLine(line)
    },
  }
}

export { findBundledCli }