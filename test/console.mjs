/**
 * 控制台的独立测试：不经 DSH 宿主，直接给 startConsole 喂假 manager / adapters，
 * 只验 HTTP 层与页面形状。跑法：node test/console.mjs
 *
 * 为什么单独一个文件：smoke.mjs 要真去 spawn qoder-cn 探活，跑一次十几秒；
 * 控制台这部分是纯逻辑，几毫秒就该跑完，改一行不想等那么久。
 */
import { startConsole } from '../lib/console.js'

const fakeMeta = {
  id: 'qoder-cn-20261128194600-abc1',
  agent: 'qoder-cn', channel: 'cli', label: '验证控制台',
  prompt: '这是一个假任务，只为验证控制台接口形状。',
  cwd: 'D:\\probe', model: 'DeepSeek-V4-Pro',
  status: 'succeeded', createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  durationMs: 12345, numTurns: 3, sessionId: 'sess-abc',
  summary: '假任务跑完了。', error: '',
  verify: { checks: [{ kind: 'file', path: 'x' }] },
}

const manager = {
  stats: () => ({ running: 0, queued: 0, maxConcurrent: 3 }),
  list: () => [fakeMeta],
  status: (id) => { if (id !== fakeMeta.id) throw new Error(`找不到任务 ${id}`); return fakeMeta },
  events: () => ({
    events: [
      { kind: 'spawn', command: 'qoderclicn -p ...' },
      { kind: 'init', model: 'Auto', cwd: fakeMeta.cwd, permissionMode: 'bypassPermissions' },
      { kind: 'say', text: '我来做这件事。' },
      { kind: 'tool', name: 'Write', input: { path: 'x.txt', content: 'hello' } },
      { kind: 'credits', total: 0.12, contextRatio: 0.11 },
      { kind: 'result', ok: true, numTurns: 3, durationMs: 12345, summary: '假任务跑完了。' },
      { kind: 'finish', status: 'succeeded' },
    ],
    total: 7,
  }),
  dispatch: async () => ({ taskId: 'fake-1', channel: 'cli' }),
  cancel: async () => ({ ok: true }),
}

const adapter = {
  id: 'qoder-cn', label: 'Qoder CN',
  async probe() {
    return { available: true, loggedIn: true, binary: 'C:\\...\\qoderclicn.exe', version: '1.1.95', detail: '已登录' }
  },
  build() {}, parse() {},
}
const adapters = { list: () => [adapter], ids: () => ['qoder-cn'], has: (id) => id === 'qoder-cn' }

const results = []
const check = (name, cond, extra = '') => {
  results.push(cond)
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
}

const handle = await startConsole({
  manager, adapters,
  config: { console: { enabled: true, port: 4790 }, defaultAgent: 'qoder-cn' },
})
if (handle === null) {
  console.error('✗ 控制台没起来')
  process.exit(1)
}
console.log('监听：', handle.url)

const page = await fetch(handle.url)
const html = await page.text()
check('页面能出来', page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html'), `${html.length} B`)
check('页面有标题与派活表单', html.includes('智能体控制台') && html.includes('id="fPrompt"') && html.includes('id="btnDispatch"'))

const overview = await (await fetch(handle.url + 'api/overview')).json()
check('概览列出适配器并探活', Array.isArray(overview.agents) && overview.agents[0]?.available === true)
check('概览给出并发状态', ['running', 'queued', 'maxConcurrent'].every((k) => typeof overview.stats[k] === 'number'))
check('任务列表收窄过（不含 verify 全文）', overview.tasks[0]?.verify === undefined && overview.tasks[0]?.hasVerify === true)
check('durationMs 是数字不是 null', typeof overview.tasks[0]?.durationMs === 'number')
check('defaultAgent 透传', overview.defaultAgent === 'qoder-cn')

const detail = await (await fetch(handle.url + 'api/tasks/' + encodeURIComponent(fakeMeta.id))).json()
check('单个任务能读', detail.summary === '假任务跑完了。')

const ev = await (await fetch(handle.url + 'api/tasks/' + encodeURIComponent(fakeMeta.id) + '/events?limit=10')).json()
check('事件流带总数', ev.total === 7 && ev.events.length === 7)

check('不存在的任务 → 404（不是 500）', (await fetch(handle.url + 'api/tasks/nope')).status === 404)
check('不存在的任务事件 → 404', (await fetch(handle.url + 'api/tasks/nope/events')).status === 404)
check('缺 prompt → 400', (await fetch(handle.url + 'api/dispatch', { method: 'POST', body: '{}' })).status === 400)
check('未知智能体 → 400', (await fetch(handle.url + 'api/dispatch', { method: 'POST', body: JSON.stringify({ agent: 'nobody', prompt: 'x' }) })).status === 400)
check('多余斜杠也能命中（// 归一）', (await fetch(handle.url + '/api/overview')).status === 200)

// 畸形请求行不该弄死服务：曾经 new URL 抛在 try 外面，一个乱发的请求能把控制台带走
const net = await import('node:net')
await new Promise((resolve) => {
  const sock = net.connect(handle.port, '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nHost: x\r\n\r\n'))
  sock.on('data', () => {})
  sock.on('close', resolve)
  sock.on('error', resolve)
  setTimeout(() => { sock.destroy(); resolve() }, 1200)
})
check('畸形请求之后服务还活着', (await fetch(handle.url + 'api/overview')).status === 200)

handle.close()
const passed = results.filter(Boolean).length
console.log(`\n=== ${passed} / ${results.length} 通过 ===`)
process.exitCode = passed === results.length ? 0 : 1
