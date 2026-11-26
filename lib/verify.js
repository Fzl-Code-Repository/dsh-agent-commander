/**
 * 验收器：不听智能体的自述，只认证据。
 *
 * 支持四类检查，每类都能独立给出「为什么通过/为什么没通过」：
 *   file     —— 文件存在、大小、内容匹配
 *   command  —— 跑一条命令，看退出码与输出
 *   git      —— 工作区是否干净、是否有新提交、分支状态
 *   absent   —— 不该存在的东西确实不在（比如临时文件被清掉）
 *
 * 所有检查都返回 { kind, ok, detail, evidence }，evidence 是可复核的原文片段。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { runCapture } from './runner.js'
import { buildTree } from './tree.js'
import { oneLine, formatBytes } from './util.js'

const MAX_READ_BYTES = 2 * 1024 * 1024

/** 把用户的相对路径解析成绝对路径（cwd 为任务的工作目录）。 */
function resolveTarget(cwd, target) {
  return path.isAbsolute(target) ? target : path.resolve(cwd, target)
}

function checkFile(cwd, spec) {
  const target = resolveTarget(cwd, String(spec.path ?? ''))
  if (!existsSync(target)) {
    return { kind: 'file', ok: false, detail: `文件不存在：${target}`, evidence: [] }
  }
  let stats
  try {
    stats = statSync(target)
  } catch (error) {
    return { kind: 'file', ok: false, detail: `无法读取 ${target}：${String(error)}`, evidence: [] }
  }
  if (stats.isDirectory()) {
    return { kind: 'file', ok: false, detail: `${target} 是目录，不是文件`, evidence: [] }
  }
  const evidence = [`大小 ${formatBytes(stats.size)}`, `修改时间 ${new Date(stats.mtimeMs).toISOString()}`]

  if (typeof spec.minBytes === 'number' && stats.size < spec.minBytes) {
    return { kind: 'file', ok: false, detail: `文件太小：${stats.size} < ${spec.minBytes} 字节`, evidence }
  }
  if (typeof spec.maxBytes === 'number' && stats.size > spec.maxBytes) {
    return { kind: 'file', ok: false, detail: `文件太大：${stats.size} > ${spec.maxBytes} 字节`, evidence }
  }
  if (typeof spec.contains === 'string' && spec.contains.length > 0) {
    if (stats.size > MAX_READ_BYTES) {
      return { kind: 'file', ok: false, detail: `文件超过 ${formatBytes(MAX_READ_BYTES)}，不敢整读；请用 command 检查`, evidence }
    }
    const body = readFileSync(target, 'utf8')
    if (!body.includes(spec.contains)) {
      return {
        kind: 'file', ok: false,
        detail: `内容里没有找到期望的片段：${oneLine(spec.contains, 80)}`,
        evidence: [...evidence, `开头：${oneLine(body, 200)}`],
      }
    }
    evidence.push(`命中片段：${oneLine(spec.contains, 80)}`)
  }
  if (typeof spec.matches === 'string' && spec.matches.length > 0) {
    if (stats.size > MAX_READ_BYTES) {
      return { kind: 'file', ok: false, detail: `文件超过 ${formatBytes(MAX_READ_BYTES)}，不敢整读；请用 command 检查`, evidence }
    }
    const body = readFileSync(target, 'utf8')
    let re
    try {
      re = new RegExp(spec.matches, 'u')
    } catch (error) {
      return { kind: 'file', ok: false, detail: `正则不合法：${String(error)}`, evidence }
    }
    if (!re.test(body)) {
      return { kind: 'file', ok: false, detail: `内容不匹配正则 ${spec.matches}`, evidence }
    }
    evidence.push(`匹配正则 ${spec.matches}`)
  }
  return { kind: 'file', ok: true, detail: `文件存在且符合要求：${target}`, evidence }
}

function checkAbsent(cwd, spec) {
  const target = resolveTarget(cwd, String(spec.path ?? ''))
  if (existsSync(target)) {
    return { kind: 'absent', ok: false, detail: `不该存在的路径仍然存在：${target}`, evidence: [] }
  }
  return { kind: 'absent', ok: true, detail: `已确认不存在：${target}`, evidence: [] }
}

async function checkCommand(cwd, spec, config) {
  const command = String(spec.command ?? '')
  if (command.length === 0) return { kind: 'command', ok: false, detail: '缺少 command', evidence: [] }
  const shell = process.platform === 'win32'
    ? (process.env.ComSpec ?? 'cmd.exe')
    : (process.env.SHELL ?? '/bin/sh')
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  const outcome = await runCapture({
    binary: shell,
    args: shellArgs,
    cwd,
    timeoutMs: typeof spec.timeoutMs === 'number' ? spec.timeoutMs : 120000,
    maxBytes: 400000,
  })
  const evidence = [
    `$ ${oneLine(command, 200)}`,
    `退出码 ${outcome.exitCode}`,
    ...(outcome.stdout.trim().length > 0 ? [`stdout:\n${oneLine(outcome.stdout, 1500)}`] : []),
    ...(outcome.stderr.trim().length > 0 ? [`stderr:\n${oneLine(outcome.stderr, 800)}`] : []),
  ]
  const expectExit = typeof spec.expectExitCode === 'number' ? spec.expectExitCode : 0
  if (outcome.exitCode !== expectExit) {
    return { kind: 'command', ok: false, detail: `退出码 ${outcome.exitCode}，期望 ${expectExit}`, evidence }
  }
  if (typeof spec.contains === 'string' && spec.contains.length > 0) {
    const haystack = `${outcome.stdout}\n${outcome.stderr}`
    if (!haystack.includes(spec.contains)) {
      return { kind: 'command', ok: false, detail: `输出里没有期望的片段：${oneLine(spec.contains, 80)}`, evidence }
    }
    evidence.push(`命中片段：${oneLine(spec.contains, 80)}`)
  }
  return { kind: 'command', ok: true, detail: `命令按预期通过（退出码 ${outcome.exitCode}）`, evidence }
}

async function checkGit(cwd, spec) {
  const repo = resolveTarget(cwd, String(spec.repo ?? '.'))
  const evidence = []
  const gitOk = await runCapture({ binary: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: repo, timeoutMs: 20000 })
  if (!gitOk.ok || !gitOk.stdout.includes('true')) {
    return { kind: 'git', ok: false, detail: `${repo} 不是 git 工作区`, evidence: [oneLine(gitOk.stderr, 300)] }
  }

  if (spec.clean === true) {
    const status = await runCapture({ binary: 'git', args: ['status', '--porcelain'], cwd: repo, timeoutMs: 30000 })
    const dirty = status.stdout.split('\n').filter((line) => line.trim().length > 0)
    evidence.push(`git status --porcelain：${dirty.length === 0 ? '(空)' : `\n${dirty.slice(0, 20).join('\n')}`}`)
    if (dirty.length > 0) {
      return { kind: 'git', ok: false, detail: `工作区不干净，有 ${dirty.length} 项未提交改动`, evidence }
    }
  }

  if (spec.hasCommit === true) {
    const log = await runCapture({ binary: 'git', args: ['log', '-1', '--pretty=%H%n%s%n%cI'], cwd: repo, timeoutMs: 20000 })
    if (!log.ok || log.stdout.trim().length === 0) {
      return { kind: 'git', ok: false, detail: '读不到任何提交', evidence }
    }
    const [hash, subject, when] = log.stdout.trim().split('\n')
    evidence.push(`最新提交 ${hash.slice(0, 10)} · ${when} · ${oneLine(subject, 100)}`)
    if (typeof spec.messageContains === 'string' && spec.messageContains.length > 0) {
      if (!(subject ?? '').includes(spec.messageContains)) {
        return { kind: 'git', ok: false, detail: `提交信息里没有「${spec.messageContains}」`, evidence }
      }
    }
  }

  if (typeof spec.branch === 'string' && spec.branch.length > 0) {
    const branch = await runCapture({ binary: 'git', args: ['branch', '--show-current'], cwd: repo, timeoutMs: 20000 })
    const current = branch.stdout.trim()
    evidence.push(`当前分支 ${current.length > 0 ? current : '(detached)'}`)
    if (current !== spec.branch) {
      return { kind: 'git', ok: false, detail: `当前分支是 ${current}，期望 ${spec.branch}`, evidence }
    }
  }

  return { kind: 'git', ok: true, detail: 'git 状态符合预期', evidence }
}

function checkTree(cwd, spec) {
  const root = resolveTarget(cwd, String(spec.path ?? '.'))
  if (!existsSync(root)) {
    return { kind: 'tree', ok: false, detail: `目录不存在：${root}`, evidence: [] }
  }
  const tree = buildTree(root, { maxEntries: typeof spec.maxEntries === 'number' ? spec.maxEntries : 200 })
  const matches = spec.pattern === undefined ? tree.entries.map((entry) => entry.path) : tree.entries
    .map((entry) => entry.path)
    .filter((entryPath) => {
      try {
        return new RegExp(spec.pattern, 'u').test(entryPath)
      } catch {
        return false
      }
    })
  const evidence = tree.entries.slice(0, 40).map((entry) => `${entry.path}${entry.type === 'dir' ? '/' : ''}`)
  const min = typeof spec.minCount === 'number' ? spec.minCount : 1
  if (matches.length < min) {
    return {
      kind: 'tree', ok: false,
      detail: `${root} 下匹配 ${spec.pattern ?? '*'} 的条目只有 ${matches.length} 个，要求至少 ${min} 个`,
      evidence,
    }
  }
  return {
    kind: 'tree', ok: true,
    detail: `${root} 下匹配 ${spec.pattern ?? '*'} 的条目 ${matches.length} 个（要求 ≥ ${min}）`,
    evidence: [...evidence, `匹配：${matches.slice(0, 20).join(', ')}`],
  }
}

/**
 * 跑一组检查。
 * @param {object} options
 * @param {string} options.cwd 任务工作目录（相对路径基准）
 * @param {object[]} options.checks 检查列表
 */
export async function runChecks({ cwd, checks }) {
  const results = []
  for (const spec of checks) {
    const kind = String(spec?.kind ?? '')
    try {
      if (kind === 'file') results.push(checkFile(cwd, spec))
      else if (kind === 'absent') results.push(checkAbsent(cwd, spec))
      else if (kind === 'command') results.push(await checkCommand(cwd, spec))
      else if (kind === 'git') results.push(await checkGit(cwd, spec))
      else if (kind === 'tree') results.push(checkTree(cwd, spec))
      else results.push({ kind: kind.length > 0 ? kind : 'unknown', ok: false, detail: `未知检查类型 ${kind}；可用 file/absent/command/git/tree`, evidence: [] })
    } catch (error) {
      results.push({ kind: kind.length > 0 ? kind : 'unknown', ok: false, detail: `检查抛出异常：${String(error)}`, evidence: [] })
    }
  }
  const passed = results.filter((item) => item.ok).length
  return {
    ok: results.length > 0 && passed === results.length,
    passed,
    total: results.length,
    results,
  }
}

/** 自动推断一组「文件类」证据：目录下新增/修改了哪些文件，便于无条款时也能看一眼。 */
export function diffSnapshot(before, after) {
  const added = []
  const changed = []
  const removed = []
  for (const [key, entry] of after) {
    const previous = before.get(key)
    if (previous === undefined) added.push(entry)
    else if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) changed.push(entry)
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push(entry)
  }
  return { added, changed, removed }
}

/** 给目录做一次轻量快照（只记大小与修改时间，不读内容）。 */
export function snapshotTree(root, { maxEntries = 2000, ignore = ['.git', 'node_modules', '.venv', 'dist', 'build'] } = {}) {
  const out = new Map()
  if (!existsSync(root)) return out
  const stack = [root]
  let count = 0
  while (stack.length > 0 && count < maxEntries) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const stats = statSync(full)
        out.set(path.relative(root, full), { path: path.relative(root, full), size: stats.size, mtimeMs: stats.mtimeMs })
        count += 1
      } catch {
        // 忽略
      }
    }
  }
  return out
}