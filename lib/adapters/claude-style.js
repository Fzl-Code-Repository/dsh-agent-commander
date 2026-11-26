/**
 * Claude Code 系协议的通用解析器。
 *
 * Qoder CN 的 qoderclicn 与 WorkBuddy 自带 codebuddy 都由 Claude Code 派生，
 * stream-json 行格式一致，所以解析逻辑抽到这里共用；
 * 各自的适配器只保留「怎么起进程」与个别差异。
 */
import os from 'node:os'
import path from 'node:path'
import { event } from './base.js'
import { oneLine, safeJsonParse } from '../util.js'

const NOISE_PATTERNS = [
  /Skipped invalid MCP server/u,
  /^Warning:/u,
  /^npm warn/u,
]

function isNoise(line) {
  return NOISE_PATTERNS.some((pattern) => pattern.test(line))
}

export function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (typeof item === 'string') return item
      if (item !== null && typeof item === 'object' && typeof item.text === 'string') return item.text
      return ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function parseAssistant(message) {
  const events = []
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
      events.push(event.thinking(block.thinking.trim()))
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      events.push(event.say(block.text.trim()))
    } else if (block.type === 'tool_use') {
      events.push(event.tool(String(block.name ?? 'unknown'), block.input ?? {}, block.id))
    }
  }
  const usage = message?.usage
  if (usage !== null && typeof usage === 'object') {
    const credits = typeof usage.credits === 'number' ? usage.credits : undefined
    const ratio = typeof usage.context_usage_ratio === 'number' ? usage.context_usage_ratio : undefined
    if (credits !== undefined || ratio !== undefined) events.push(event.credits(credits, ratio))
  }
  return events
}

/** 解析一行 stream-json；返回统一事件数组。 */
export function parseClaudeStyleLine(line) {
  const trimmed = line.trim()
  if (trimmed.length === 0) return []
  if (!trimmed.startsWith('{')) {
    return [isNoise(trimmed) ? event.notice(trimmed) : event.raw(trimmed)]
  }
  const parsed = safeJsonParse(trimmed, undefined)
  if (parsed === undefined) return [event.raw(trimmed)]

  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined

  if (parsed.type === 'system') {
    if (parsed.subtype === 'init') {
      return [event.init({
        sessionId,
        model: parsed.model,
        cwd: parsed.cwd,
        permissionMode: parsed.permissionMode ?? parsed.permission_mode,
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      })]
    }
    if (parsed.subtype === 'permission_denied') {
      return [event.notice(`权限被拒：${oneLine(toolResultText(parsed.message ?? parsed.reason ?? ''))}`)]
    }
    return []
  }

  if (parsed.type === 'assistant') return parseAssistant(parsed.message)

  if (parsed.type === 'user') {
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message.content : []
    const events = []
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue
      events.push(event.toolResult(
        block.tool_use_id,
        block.is_error !== true,
        oneLine(toolResultText(block.content), 1200),
      ))
    }
    return events
  }

  if (parsed.type === 'result') {
    const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials : []
    return [event.result({
      ok: (parsed.subtype === undefined || parsed.subtype === 'success') && parsed.is_error !== true,
      summary: typeof parsed.result === 'string' ? parsed.result : '',
      numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : undefined,
      durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
      sessionId,
      credits: typeof parsed.total_credits === 'number' ? parsed.total_credits : undefined,
      denials: denials.map((item) => oneLine(toolResultText(item?.tool_name ?? item?.toolName ?? item), 200)),
      subtype: parsed.subtype,
    })]
  }

  return [event.raw(trimmed)]
}

/**
 * 本机 node 可执行文件。子进程里的 process.execPath 就是跑 DSH 的那个 node；
 * 若 DSH 跑在 Electron 里（ELECTRON_RUN_AS_NODE），execPath 是 electron 本体，
 * 仍然可以当 node 用，所以直接返回它。
 */
export function NODE_BIN() {
  return process.execPath
}

export { path, os }