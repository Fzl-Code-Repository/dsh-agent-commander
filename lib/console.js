/**
 * 控制台：把插件的能力落成一个能打开的网页。
 *
 * 为什么要有它：这个插件的全部能力都在对话里 —— 派了几单、跑到哪一步、
 * 验收过没过，只有翻 trace 才看得见。指挥别的智能体干活本来就是个「看板」
 * 场景：谁在忙、谁闲着、哪单没过验收，一张屏应该看完。
 *
 * 设计约束（都很刻意）：
 *   - 只用 node 内置 http，不引框架不引构建工具。插件是 link 进 profile 的，
 *     装个 express 就多了个会被宿主一起加载的依赖树。
 *   - 只监听 127.0.0.1，且端口探测是「从 basePort 往上找一个能绑的」，
 *     不写死 —— 本机 8080/8083/8092 都被别的项目占着。
 *   - 前端是单文件内联 HTML/CSS/JS。没有打包步骤，改完刷新就生效。
 *   - 数据全部走 JSON 接口，前端不内嵌任何状态。刷新页面不丢东西。
 *   - 派活和取消复用 SessionManager 的同一条路径，不另起一套执行逻辑 ——
 *     网页上派出去的任务，agent_report / agent_verify 一样能查到。
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runChecks, snapshotTree, diffSnapshot } from './verify.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, 'console.html')

/** 允许从浏览器派活的字段白名单；不信任请求体里的其他任何东西。 */
const DISPATCH_FIELDS = ['agent', 'prompt', 'cwd', 'label', 'model', 'channel', 'resumeSessionId', 'verifySeconds']

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, limitBytes = 1024 * 512) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 从 basePort 起找一个能绑的端口。
 * 本机 8080/8083/8092/8098/8099 都被别的项目占着，写死必然撞。
 */
function listenOnFreePort(server, basePort, host, maxTries = 40) {
  return new Promise((resolve, reject) => {
    let port = basePort
    let tries = 0
    const attempt = () => {
      const onError = (err) => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE' && tries < maxTries) {
          tries += 1
          port += 1
          attempt()
          return
        }
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve(port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    attempt()
  })
}

/**
 * 起控制台。
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> } | null>}
 */
export async function startConsole({ manager, adapters, config }) {
  const consoleConfig = config?.console ?? {}
  if (consoleConfig.enabled === false) return null

  const host = '127.0.0.1'
  const basePort = Number(consoleConfig.port) > 0 ? Math.floor(Number(consoleConfig.port)) : 4790
  const page = readFileSync(PAGE)

  const server = http.createServer(async (req, res) => {
    // 解析 URL 必须在 try 里：请求行畸形（比如 "//"）时 new URL 会抛，
    // 抛在 try 外就是未捕获异常 —— 一个乱发的请求能把整个控制台带走。
    let route = ''
    // manager.status 找不到会抛；控制台里「读一个不存在的任务」是正常路径
    // （前端轮询的任务刚好被清理掉），所以统一用这个读法，找不到返回 undefined。
    const readMeta = (id) => {
      try {
        return manager.status(id)
      } catch {
        return undefined
      }
    }
    try {
      // 先压掉请求行开头的重复斜杠再交给 URL：`new URL('//api/overview', base)`
      // 会把 `//api` 当成**协议相对的主机名**，pathname 直接变成 '/'，
      // 于是拼出来的 URL 多一个斜杠就成了 404 —— 这不是调用方的错。
      const rawUrl = (req.url ?? '/').replace(/^\/{2,}/, '/')
      const url = new URL(rawUrl, `http://${host}`)
      // 再合并路径中间的重复斜杠（`/api//overview` 与 `/api/overview` 等价）。
      const pathname = url.pathname.replace(/\/{2,}/g, '/')
      route = `${req.method} ${pathname}`

      // ── 页面 ──────────────────────────────────────────────
      if (route === 'GET /' || route === 'GET /index.html') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': page.length,
        })
        res.end(page)
        return
      }

      // ── 概览：谁可用、并发情况、最近任务 ──────────────────
      if (route === 'GET /api/overview') {
        const probes = await Promise.all(adapters.list().map(async (adapter) => {
          let probe = { available: false, loggedIn: false, binary: '', version: '', detail: '探活失败' }
          try {
            probe = await adapter.probe()
          } catch (error) {
            probe = { available: false, loggedIn: false, binary: '', version: '', detail: String(error?.message ?? error) }
          }
          return {
            id: adapter.id,
            label: adapter.label ?? adapter.id,
            available: probe.available === true,
            loggedIn: probe.loggedIn === true,
            binary: probe.binary ?? '',
            version: probe.version ?? '',
            detail: probe.detail ?? '',
            supportsDesktop: adapter.id === 'qoder-cn',
          }
        }))
        json(res, 200, {
          agents: probes,
          stats: manager.stats(),
          defaultAgent: config?.defaultAgent ?? probes[0]?.id ?? '',
          tasks: manager.list(Number(consoleConfig.recentTasks) > 0 ? Number(consoleConfig.recentTasks) : 30).map(shapeTask),
        })
        return
      }

      // ── 单个任务详情（含事件流） ─────────────────────────
      if (req.method === 'GET' && pathname.startsWith('/api/tasks/')) {
        const taskId = decodeURIComponent(pathname.slice('/api/tasks/'.length))
        if (taskId.endsWith('/events')) {
          const id = taskId.slice(0, -'/events'.length)
          if (readMeta(id) === undefined) {
            json(res, 404, { error: `找不到任务 ${id}` })
            return
          }
          const fromIndex = Number(url.searchParams.get('from') ?? 0) || 0
          const limit = Number(url.searchParams.get('limit') ?? 400) || 400
          const { events, total } = manager.events(id, { fromIndex, limit })
          json(res, 200, { taskId: id, total, from: fromIndex, events })
          return
        }
        const meta = readMeta(taskId)
        // 找不到就是 404，不能是 500：前端轮询一个已经不在的任务时，
        // 500 会被当成「服务坏了」弹告警，而真相只是这条记录没了。
        if (meta === undefined) {
          json(res, 404, { error: `找不到任务 ${taskId}` })
          return
        }
        json(res, 200, shapeTask(meta))
        return
      }

      // ── 派活 ─────────────────────────────────────────────
      if (route === 'POST /api/dispatch') {
        const body = await readBody(req)
        const input = {}
        for (const key of DISPATCH_FIELDS) {
          if (body[key] !== undefined && body[key] !== null) input[key] = body[key]
        }
        if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
          json(res, 400, { error: 'prompt 不能为空' })
          return
        }
        if (typeof input.agent !== 'string' || !adapters.has(input.agent)) {
          json(res, 400, { error: `未知智能体；可用：${adapters.ids().join('、')}` })
          return
        }
        if (typeof input.cwd === 'string' && input.cwd.trim() === '') delete input.cwd
        const result = manager.dispatch(input)
        json(res, 200, result)
        return
      }

      // ── 取消 ─────────────────────────────────────────────
      if (req.method === 'POST' && pathname.startsWith('/api/tasks/') && pathname.endsWith('/cancel')) {
        const id = decodeURIComponent(pathname.slice('/api/tasks/'.length, -'/cancel'.length))
        json(res, 200, manager.cancel(id, '从控制台取消'))
        return
      }

      // ── 验收 ─────────────────────────────────────────────
      if (req.method === 'POST' && pathname.startsWith('/api/tasks/') && pathname.endsWith('/verify')) {
        const id = decodeURIComponent(pathname.slice('/api/tasks/'.length, -'/verify'.length))
        const meta = readMeta(id)
        if (meta === undefined) {
          json(res, 404, { error: `找不到任务 ${id}` })
          return
        }
        const body = await readBody(req)
        const checks = Array.isArray(body.checks) && body.checks.length > 0 ? body.checks : meta.verify?.checks
        const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : meta.cwd

        // 没写验收条款时不能只回 400 —— 页面上的「验收」按钮对已结束的任务是可点的，
        // 点了必然失败等于死路。退化成 agent_verify 那套「无条款模式」：
        // 快照出任务开始后改动过的文件，让「它到底动了什么」有据可查。
        if (!Array.isArray(checks) || checks.length === 0) {
          const changes = []
          try {
            for (const entry of snapshotTree(cwd).values()) {
              if (entry.mtimeMs >= Date.parse(meta.createdAt ?? '')) {
                changes.push({ path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs })
              }
            }
          } catch {
            // 目录读不了就当没改动；不能因为快照失败把整个接口打成 500
          }
          changes.sort((a, b) => b.mtimeMs - a.mtimeMs)
          const note = changes.length > 0
            ? `没写验收条款，只能给个旁证：${cwd} 下自任务开始后有 ${changes.length} 个文件被改动。要严格验收请在请求里给 checks。`
            : `没写验收条款，且 ${cwd} 下自任务开始后没有文件改动。若这单本该改文件，基本可以判定它没干成。`
          json(res, 200, {
            taskId: id,
            cwd,
            ok: false,
            passed: 0,
            total: 0,
            results: [],
            changes: changes.slice(0, 100),
            note,
            at: new Date().toISOString(),
          })
          return
        }

        // 原样透传 runChecks 的返回：{ ok 布尔, passed 计数, total, results }。
        // 注意区分 ok 与 passed —— 前端曾把 passed 当布尔、又去取不存在的 passedCount，
        // 结果是徽章对了但计数显示 undefined。字段名三层（库/接口/页面）必须一致。
        const result = await runChecks({ cwd, checks })
        json(res, 200, { taskId: id, cwd, ...result, changes: [], note: '', at: new Date().toISOString() })
        return
      }

      json(res, 404, { error: `没有这个接口：${route}` })
    } catch (error) {
      json(res, 500, { error: String(error?.message ?? error) })
    }
  })

  const port = await listenOnFreePort(server, basePort, host)
  const url = `http://${host}:${port}/`

  // 不 unref 会出现两个问题：脚本化使用（冒烟测试、一次性命令）跑完不退出，
  // 进程被一个「没人访问的控制台」吊住。unref 之后行为与 Web 服务器惯例一致：
  // 有别的活干时它照常服务，其余事都做完了就允许进程退出。
  // 注意这与 manager.waitFor 里那个定时器 bug 不是一回事 —— 那里有人在 await
  // 一个结果，unref 会让它永远等不到；这里没人等，纯粹是「有请求就响应」。
  server.unref?.()

  return {
    url,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * 把 meta 收成前端要的形状。
 * 这一层是有必要的：meta.json 里有些字段是内部的（result 原始对象、
 * verify.checks 全文），前端不需要也不该自己挑字段。
 */
function shapeTask(meta) {
  return {
    id: meta.id,
    agent: meta.agent,
    channel: meta.channel ?? 'cli',
    label: meta.label ?? '',
    prompt: meta.prompt ?? '',
    cwd: meta.cwd ?? '',
    model: meta.model ?? '',
    status: meta.status ?? 'queued',
    createdAt: meta.createdAt ?? '',
    startedAt: meta.startedAt ?? '',
    finishedAt: meta.finishedAt ?? '',
    durationMs: Number(meta.durationMs ?? 0),
    numTurns: Number(meta.numTurns ?? 0),
    sessionId: meta.sessionId ?? '',
    summary: meta.summary ?? '',
    error: meta.error ?? '',
    screenshot: meta.screenshot ?? '',
    guiSessionFile: meta.guiSessionFile ?? '',
    hasVerify: Array.isArray(meta.verify?.checks) && meta.verify.checks.length > 0,
    verifyChecks: Array.isArray(meta.verify?.checks) ? meta.verify.checks.length : 0,
  }
}

export { shapeTask }
