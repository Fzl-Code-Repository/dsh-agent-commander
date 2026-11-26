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
 *   - 登录态：未登录时 --print 直接返回 401。token 可由 CODEBUDDY_AUTH_TOKEN 环境变量注入，
 *     见 codebuddy-auth.js（自行实现的设备码流程）。
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { runCapture } from '../runner.js'
import { event } from './base.js'
import { expandHome } from '../paths.js'
import { oneLine, safeJsonParse } from '../util.js'
import { parseClaudeStyleLine, NODE_BIN } from './claude-style.js'
import { requestLoginState, waitForLoginToken } from './codebuddy-auth.js'

const INSTALL_ROOTS = [
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WorkBuddy'),
  path.join(process.env.PROGRAMFILES ?? 'C:\\\\Program Files', 'WorkBuddy'),
]

/** codebuddy 的 home 目录，默认 ~/.codebuddy。 */
function codebuddyHome() {
  const override = process.env.CODEBUDDY_CONFIG_DIR
  if (typeof override === 'string' && override.length > 0) return expandHome(override)
  return path.join(os.homedir(), '.codebuddy')
}

/** codebuddy 认的用户级 settings.json。 */
function userSettingsPath() {
  return path.join(codebuddyHome(), 'settings.json')
}

/** 读已有 token（settings.json 的 env.CODEBUDDY_AUTH_TOKEN）。 */
export function readStoredToken() {
  try {
    const p = userSettingsPath()
    if (!existsSync(p)) return undefined
    const json = JSON.parse(readFileSync(p, 'utf8'))
    const token = json?.env?.CODEBUDDY_AUTH_TOKEN
    return typeof token === 'string' && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/** 把 token 写进 settings.json 的 env，保留其它字段。 */
export function storeToken(token, extra = {}) {
  const p = userSettingsPath()
  mkdirSync(path.dirname(p), { recursive: true })
  let json = {}
  try {
    if (existsSync(p)) json = JSON.parse(readFileSync(p, 'utf8')) ?? {}
  } catch {
    json = {}
  }
  if (typeof json !== 'object' || json === null) json = {}
  const env = typeof json.env === 'object' && json.env !== null ? json.env : {}
  env.CODEBUDDY_AUTH_TOKEN = token
  json.env = env
  if (Object.keys(extra).length > 0) {
    json.codebuddyAuth = { ...(json.codebuddyAuth ?? {}), ...extra }
  }
  writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  return p
}

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

      // 有 token 才敢说「已登录」；否则只能说「有 CLI，能不能干活未知」。
      // 不去真的发一次请求：探测要便宜，且不该消耗额度。
      const token = readStoredToken() ?? (typeof process.env.CODEBUDDY_AUTH_TOKEN === 'string' ? process.env.CODEBUDDY_AUTH_TOKEN : undefined)
      const hasToken = typeof token === 'string' && token.length > 0
      parts.push(hasToken ? '已配置 token' : '未登录（用 agent_login 登录）')

      return {
        available: true,
        binary,
        version: version.ok ? version.stdout.trim().split('\n')[0] : undefined,
        loggedIn: hasToken,
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

      // token 从 settings.json 读出来塞进子进程环境。
      // 好处：不用真的把 settings.json 写脏也能干活；写脏只是给别的 codebuddy 调用方复用。
      const token = readStoredToken()
      const env = {}
      if (typeof token === 'string' && token.length > 0) env.CODEBUDDY_AUTH_TOKEN = token

      return {
        binary: isScript ? NODE_BIN() : binary,
        args: isScript ? [binary, ...args] : args,
        cwd: task.cwd ?? config.cwd ?? undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        timeoutMs: globalConfig?.timeoutMs,
        graceMs: globalConfig?.graceMs,
      }
    },

    parse(line) {
      return parseClaudeStyleLine(line)
    },

    /**
     * 登录：申请设备码 → 返回要用户打开的 URL → 后台等他授权 → token 落地。
     * 返回的对象里 waitFor() 是个可等待的 promise，调用方可以先把手上的事说完再等。
     */
    async login(options = {}) {
      const { state, authUrl, baseUrl } = await requestLoginState({ baseUrl: options.baseUrl })
      const controller = new AbortController()
      const waitMs = options.timeoutMs ?? 300000
      // 只等一次：重复等要复用同一个 promise，否则会重复轮询、重复写盘。
      let started
      const waitFor = () => (started ??= (async () => {
        try {
          const result = await waitForLoginToken({ state, baseUrl, timeoutMs: waitMs, signal: controller.signal })
          const savedTo = storeToken(result.accessToken, {
            account: result.account,
            savedAt: new Date().toISOString(),
          })
          return { ok: true, savedTo, account: result.account, tokenLength: result.accessToken.length }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })())
      return {
        state,
        authUrl,
        expiresInMs: waitMs,
        cancel: () => controller.abort(),
        waitFor,
      }
    },

    async logout() {
      const p = userSettingsPath()
      if (!existsSync(p)) return { ok: true, detail: '没有 settings.json，本来就没登录' }
      try {
        const json = JSON.parse(readFileSync(p, 'utf8')) ?? {}
        if (json?.env && typeof json.env === 'object') {
          delete json.env.CODEBUDDY_AUTH_TOKEN
          writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
        }
        return { ok: true, detail: `已从 ${p} 移除 token` }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

export { findBundledCli, userSettingsPath, codebuddyHome }