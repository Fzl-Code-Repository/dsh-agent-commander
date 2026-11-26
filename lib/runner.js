/**
 * 子进程运行器：起一个 CLI、按行流式回调、超时可杀、退出码与 stderr 都留住。
 *
 * 为什么不用 execFile：我们需要「边跑边读行」，长任务可能要跑半小时，
 * 一次性收集 buffer 既看不到进度，也容易把内存吃满。
 */
import { spawn } from 'node:child_process'
import { expandHome } from './paths.js'

/** Windows 上 .cmd/.bat 必须走 shell，直接 spawn 会 ENOENT/EINVAL。 */
function needsShell(binary) {
  return process.platform === 'win32' && /\.(cmd|bat)$/iu.test(binary)
}

/**
 * @param {object} options
 * @param {string} options.binary 可执行文件
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {Record<string,string>} [options.env] 追加/覆盖的环境变量
 * @param {number} [options.timeoutMs] 超时先 SIGTERM
 * @param {number} [options.graceMs] 宽限后 SIGKILL
 * @param {AbortSignal} [options.signal]
 * @param {(line: string) => void} [options.onStdoutLine]
 * @param {(line: string) => void} [options.onStderrLine]
 * @param {number} [options.maxLineBytes] 单行上限，防止超长行炸内存
 */
export function runStreaming(options) {
  const {
    binary, args = [], cwd, env = {}, timeoutMs = 1800000, graceMs = 5000,
    signal, onStdoutLine, onStderrLine, maxLineBytes = 4 * 1024 * 1024, stdinText,
  } = options

  const exe = expandHome(binary)
  const useShell = needsShell(exe)

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const stdoutLines = []
    const stderrChunks = []
    let timedOut = false
    let aborted = false
    let settled = false
    let killTimer = null
    let timeoutTimer = null

    let child
    try {
      child = spawn(exe, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: useShell,
        windowsHide: true,
        stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        ok: false, exitCode: null, signal: null, spawnError: error instanceof Error ? error.message : String(error),
        durationMs: 0, stderr: '', stdoutLines, timedOut: false, aborted: false,
      })
      return
    }

    if (stdinText !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(stdinText)
    }

    /** 逐行切分，处理跨 chunk 的半行。 */
    function lineSplitter(handler, sink) {
      let buffer = ''
      return {
        push(chunk) {
          buffer += chunk
          if (buffer.length > maxLineBytes) {
            buffer = buffer.slice(-maxLineBytes)
          }
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/u, '')
            buffer = buffer.slice(index + 1)
            if (line.length > 0) {
              sink?.push(line)
              handler?.(line)
            }
            index = buffer.indexOf('\n')
          }
        },
        flush() {
          const line = buffer.replace(/\r$/u, '')
          buffer = ''
          if (line.length > 0) {
            sink?.push(line)
            handler?.(line)
          }
        },
      }
    }

    const outSplitter = lineSplitter(onStdoutLine, stdoutLines)
    const errSplitter = lineSplitter(onStderrLine, null)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => outSplitter.push(String(chunk)))
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(String(chunk))
      errSplitter.push(String(chunk))
    })

    function onAbort() {
      aborted = true
      terminate()
    }

    function terminate() {
      if (child.killed) return
      try {
        child.kill('SIGTERM')
      } catch {
        // 已经退出
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已经退出
        }
      }, graceMs)
      killTimer.unref?.()
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate()
      }, timeoutMs)
      timeoutTimer.unref?.()
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        aborted = true
        terminate()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    function cleanup() {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      if (killTimer !== null) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    function finish(exitCode, exitSignal, spawnError) {
      if (settled) return
      settled = true
      cleanup()
      outSplitter.flush()
      errSplitter.flush()
      resolve({
        ok: spawnError === undefined && !timedOut && !aborted && exitCode === 0,
        exitCode,
        signal: exitSignal ?? null,
        spawnError,
        durationMs: Date.now() - startedAt,
        stderr: stderrChunks.join(''),
        stdoutLines,
        timedOut,
        aborted,
      })
    }

    child.on('error', (error) => finish(null, null, error instanceof Error ? error.message : String(error)))
    child.on('close', (code, exitSignal) => finish(code, exitSignal, undefined))
  })
}

/** 跑一个短命令并把输出全收下来（用于 probe / 验收命令）。 */
export function runCapture(options) {
  const { timeoutMs = 60000, maxBytes = 200000 } = options
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const exe = expandHome(options.binary)
    const useShell = needsShell(exe)
    let child
    try {
      child = spawn(exe, options.args ?? [], {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        shell: useShell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', spawnError: String(error), durationMs: 0, truncated: false })
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let truncated = false
    let settled = false
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      outBytes += Buffer.byteLength(String(chunk))
      if (outBytes > maxBytes) {
        truncated = true
        return
      }
      out.push(String(chunk))
    })
    child.stderr?.on('data', (chunk) => {
      if (Buffer.byteLength(err.join('')) > maxBytes) return
      err.push(String(chunk))
    })

    function finish(exitCode, spawnError) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: spawnError === undefined && exitCode === 0,
        exitCode: exitCode ?? null,
        stdout: out.join(''),
        stderr: err.join(''),
        spawnError,
        durationMs: Date.now() - startedAt,
        truncated,
      })
    }

    child.on('error', (error) => finish(null, String(error)))
    child.on('close', (code) => finish(code, undefined))
  })
}