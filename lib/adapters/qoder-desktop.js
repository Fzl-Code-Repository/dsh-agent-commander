/**
 * Qoder CN 桌面 GUI 投递通道。
 *
 * 为什么需要它：插件原来的 qoder-cn 适配器走 `qoderclicn.exe -p`（无头 print 模式）——
 * 那是拿账号 API 在后台跑，任务**不会出现在用户桌面上的 Qoder CN 窗口里**。
 * 用户明确要求「操作我桌面上的 Qoder CN，不是拿账号 API 开发」。
 *
 * 实测结论（2026-11-28，Qoder CN 桌面端）：
 *   - 桌面 GUI 的会话**不写 SQLite** local.db（chat_session 停在 143 行、mtime 不动）；
 *     它复用 CLI 的会话引擎，写 `~/.qoder-cn/projects/<路径转连字符>/<uuid>.jsonl`，
 *     所以「往 local.db 插记录让 GUI 显示会话」这条路是不成立的。
 *   - 桌面端也没有暴露本地任务投递端口（127.0.0.1:3674 是真 HTTP 服务但探了 18 个路径全 404；
 *     3663 是本地代理，返回 407）。
 *   - 唯一可靠通道是**模拟用户操作**：窗口前台化 → Ctrl+N → 剪贴板 Ctrl+V → Enter。
 *     已验证三次，任务真的进了 GUI、真的被执行、会话出现在左侧「最近任务」。
 *
 * 代价（如实写在这里，别假装没有）：
 *   - 会抢占前台焦点 1–3 秒，期间不能并发调用（两次同时跑会互相抢焦点、文本串台）。
 *   - 拿不到结构化的执行结果，只能靠截图 + 事后读 jsonl。
 *   - Qoder 改版（改快捷键 / 改输入框 / 改 Enter 行为）会让它失效。
 *
 * 实现走 PowerShell 脚本，因为需要 Win32（SetForegroundWindow / keybd_event / DPI 声明）
 * 和剪贴板访问，node 直接做这些要么要装原生依赖，要么很容易在前台锁上翻车。
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { runCapture } from '../runner.js'

/** 桌面端主窗口的进程名（Get-Process 的 ProcessName）。 */
export const DESKTOP_PROCESS_NAME = 'Qoder CN'

/** 桌面端默认安装路径，仅用于 probe 报错时提示用户去哪看。 */
export const DESKTOP_DEFAULT_EXE = 'D:\\development\\qodercn\\Qoder CN\\Qoder CN.exe'

/**
 * 把任务文本投递进桌面 Qoder CN。
 *
 * @param {object} options
 * @param {string} options.prompt       任务正文
 * @param {string} [options.scriptPath] 投递脚本路径（默认在插件 state 目录里生成）
 * @param {boolean} [options.newTask]   是否 Ctrl+N 开新任务（默认 true）
 * @param {boolean} [options.submit]    是否按 Enter 提交（默认 true；false = 只填不提交）
 * @param {number} [options.verifySeconds] 提交后等几秒再截图（默认 12）
 * @param {string} [options.shotDir]    截图目录
 * @param {number} [options.timeoutMs]  整体超时
 * @returns {Promise<{ ok: boolean, exitCode: number, script: string, screenshot?: string, text: string }>}
 */
export async function deliverToDesktopTask(options = {}) {
  const prompt = typeof options.prompt === 'string' ? options.prompt : ''
  if (prompt.trim().length === 0) {
    return { ok: false, exitCode: -1, script: '', text: '任务正文为空，无法投递。' }
  }

  const scriptPath = options.scriptPath ?? defaultScriptPath()
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      exitCode: -1,
      script: scriptPath,
      text: `找不到投递脚本：${scriptPath}。这是插件自带的脚本，缺失说明安装不完整。`,
    }
  }

  // 任务文本走临时文件，不走命令行参数：
  // 中文/引号/换行在 PowerShell 参数里转义规则很坑，写文件最稳。
  const taskFile = path.join(os.tmpdir(), `qoder-desktop-task-${Date.now()}.txt`)
  writeFileSync(taskFile, prompt, 'utf8')

  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-File', taskFile,
    '-VerifySeconds', String(Number.isFinite(options.verifySeconds) ? options.verifySeconds : 12),
  ]
  if (options.shotDir !== undefined) args.push('-ShotDir', options.shotDir)
  if (options.newTask === false) args.push('-NoNewTask')
  if (options.submit === false) args.push('-NoSubmit')

  const outcome = await runCapture({
    binary: 'powershell',
    args,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 180000,
  })

  const text = `${outcome.stdout}\n${outcome.stderr}`.trim()
  const shotMatch = /screenshot \(after submit\): (.+\.png)/.exec(outcome.stdout)
  return {
    ok: outcome.ok,
    exitCode: outcome.exitCode,
    script: scriptPath,
    screenshot: shotMatch?.[1]?.trim(),
    text,
  }
}

/** 插件自带的投递脚本放在插件目录里（随包一起发布），不写到用户 home。 */
export function defaultScriptPath() {
  return path.join(pluginRoot(), 'scripts', 'Send-QoderTask.ps1')
}

function pluginRoot() {
  // fileURLToPath 才是 Windows 上正确的做法：
  // new URL(...).pathname 会给出 /D:/F-ALL/... 这种带前导斜杠的形式，
  // 手工剥掉再把反斜杠拼回去很容易在盘符/UNC 上出错。
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * 桌面进程在不在跑。
 * @returns {Promise<{ running: boolean, pid?: number, windows: string[] }>}
 */
export async function probeDesktop() {
  const script = [
    `$p = Get-Process -Name '${DESKTOP_PROCESS_NAME}' -ErrorAction SilentlyContinue |`,
    "  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if (-not $p) { 'RUNNING=false'; exit 0 }",
    "'RUNNING=true'",
    "'PID=' + $p.Id",
    "'TITLE=' + $p.MainWindowTitle",
  ].join('\n')
  const outcome = await runCapture({
    binary: 'powershell',
    args: ['-NoProfile', '-Command', script],
    timeoutMs: 20000,
  })
  const stdout = outcome.stdout
  const running = /RUNNING=true/.test(stdout)
  const pidMatch = /PID=(\d+)/.exec(stdout)
  const titleMatch = /TITLE=(.*)/.exec(stdout)
  return {
    running,
    pid: pidMatch ? Number(pidMatch[1]) : undefined,
    windows: titleMatch?.[1]?.trim().length > 0 ? [titleMatch[1].trim()] : [],
    text: stdout.trim(),
  }
}

/**
 * 找 GUI 会话写出的 jsonl（`~/.qoder-cn/projects/<munged-path>/<uuid>.jsonl`）。
 * 用于事后取结构化结果 —— GUI 通道本身给不了，但会话文件里有。
 *
 * @param {object} [options]
 * @param {string} [options.sinceIso] 只返回 mtime 晚于这个时间的文件
 * @param {number} [options.limit]
 * @returns {Array<{ file: string, mtime: number, bytes: number }>}
 */
export function listRecentSessions(options = {}) {
  const root = path.join(os.homedir(), '.qoder-cn', 'projects')
  if (!existsSync(root)) return []
  const since = typeof options.sinceIso === 'string' ? Date.parse(options.sinceIso) : 0
  const limit = Number.isFinite(options.limit) ? options.limit : 10

  const found = []
  for (const dir of safeReaddir(root)) {
    const dirPath = path.join(root, dir)
    if (!isDirectory(dirPath)) continue
    for (const file of safeReaddir(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      const full = path.join(dirPath, file)
      const stat = safeStat(full)
      if (stat === undefined) continue
      if (Number.isFinite(since) && since > 0 && stat.mtimeMs < since) continue
      found.push({ file: full, mtime: stat.mtimeMs, bytes: stat.size })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found.slice(0, limit)
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function safeStat(p) {
  try {
    return statSync(p)
  } catch {
    return undefined
  }
}

/**
 * 把一份 GUI 会话 jsonl 解析成统一事件，供 agent_trace / agent_report 复用。
 * 只需要 type 为 user / assistant 的行；其余（attachment / active-leaf / runtime-config）忽略。
 *
 * @param {string} content jsonl 全文
 * @returns {Array<object>} 统一事件
 */
export function parseGuiSessionJsonl(content) {
  const events = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (row.type === 'user') {
      const text = extractText(row.message)
      if (text.length > 0) events.push({ kind: 'prompt', text })
      if (typeof row.cwd === 'string') events.push({ kind: 'init', cwd: row.cwd })
    } else if (row.type === 'assistant') {
      const text = extractText(row.message)
      if (text.length > 0) events.push({ kind: 'say', text })
    } else if (row.type === 'result' && row.subtype !== undefined) {
      events.push({ kind: 'result', ok: row.is_error !== true, summary: extractText(row.message), subtype: row.subtype })
    }
  }
  return events
}

function extractText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 生成截图的目录（每台机器一个固定位置，便于用户去翻）。 */
export function defaultShotDir() {
  const dir = path.join(os.homedir(), '.dsh', 'qoder-desktop-shots')
  mkdirSync(dir, { recursive: true })
  return dir
}