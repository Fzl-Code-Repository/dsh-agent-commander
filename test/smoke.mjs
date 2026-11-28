/**
 * 冒烟测试：不依赖 DSH 运行时，直接把插件当普通模块加载，
 * 用假 ctx 收集工具，然后真的指挥本机智能体干一件小事并验收。
 *
 * 跑法：node test/smoke.mjs            只测加载与探活
 *      node test/smoke.mjs --live      额外真的派一个活给 qoder-cn 并验收
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const live = process.argv.includes('--live')
const registered = new Map()

const ctx = {
  effect(factory) {
    const dispose = factory()
    return () => dispose?.()
  },
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  get() {
    return undefined
  },
  inject(_names, callback) {
    callback(ctx)
  },
  logger: { info() {}, warn() {}, error() {} },
}

/** 假 ctx 上手动跑一次 apply，拿到工具表。 */
function loadPlugin(config) {
  registered.clear()
  apply(ctx, config)
  return registered
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
}

async function main() {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'agent-commander-smoke-'))
  const dataDir = path.join(workDir, '.data')

  console.log('== 1. 加载插件')
  const tools = loadPlugin({ dataDir })
  const expected = ['agent_list', 'agent_dispatch', 'agent_status', 'agent_report', 'agent_trace', 'agent_verify', 'agent_cancel']
  for (const toolName of expected) assert(tools.has(toolName), `缺工具 ${toolName}`)
  console.log(`   ✓ 注册了 ${tools.size} 个工具：${[...tools.keys()].join(', ')}`)

  console.log('== 2. 工具 schema 自检')
  for (const [toolName, definition] of tools) {
    assert(typeof definition.description === 'string' && definition.description.length > 20, `${toolName} 缺描述`)
    assert(definition.parameters?.type === 'object', `${toolName} 参数不是 object`)
    assert(typeof definition.execute === 'function', `${toolName} 缺 execute`)
    assert(typeof definition.output?.render === 'function', `${toolName} 缺 render`)
    // DSH 的 JSON Schema 校验器只认单一 type 字符串，type 数组会让整个插件加载失败
    assertStrictSchema(definition.parameters, `${toolName}.parameters`)
    assertStrictSchema(definition.output.schema, `${toolName}.output.schema`)
    // render 必须能接受空结果而不崩，且空结果本身必须过得了 DSH 的输出校验
    const emptyValue = emptyFor(toolName)
    assertValue(emptyValue, definition.output.schema, `${toolName}.output`)
    const probe = definition.output.render({}, emptyValue)
    assert(Array.isArray(probe) && probe[0]?.type === 'text', `${toolName} 的 render 没返回 text`)
  }
  console.log('   ✓ 所有工具的描述、参数、输出、渲染都成形')
  console.log('   ✓ schema 全是 DSH 能接受的单一类型（无 type 数组、无 anyOf/oneOf）')
  console.log('   ✓ 空结果都过得了输出校验（没有 null 漏出来）')

  console.log('== 3. 探活')
  const listResult = await tools.get('agent_list').execute({})
  // 探活返回值直接过一遍输出校验 —— 这里漏 null 会让宿主报 "must be a boolean"
  assertValue(listResult, tools.get('agent_list').output.schema, 'agent_list.output')
  for (const adapter of listResult.adapters) {
    const flag = adapter.available ? (adapter.loggedIn === false ? '⚠' : '✓') : '✗'
    console.log(`   ${flag} ${adapter.id}: ${adapter.detail}`)
  }
  assert(listResult.adapters.length >= 2, '应该至少有两个适配器')

  console.log('== 4. 空状态渲染')
  const statusResult = await tools.get('agent_status').execute({})
  assertValue(statusResult, tools.get('agent_status').output.schema, 'agent_status.output')
  const statusText = tools.get('agent_status').output.render({}, statusResult)[0].text
  assert(statusText.includes('没有任务记录') || statusText.includes('并发'), '空状态渲染不对')
  console.log(`   ✓ ${statusText.split('\n')[0]}`)

  console.log('== 5. 验收器（纯本地，不涉及智能体）')
  const probeFile = path.join(workDir, 'probe.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(probeFile, 'hello-commander', 'utf8')
  const verifyResult = await tools.get('agent_verify').execute({
    cwd: workDir,
    checks: [
      { kind: 'file', path: 'probe.txt', contains: 'commander' },
      { kind: 'file', path: 'probe.txt', matches: '^hello-' },
      { kind: 'absent', path: 'nope.txt' },
      { kind: 'tree', path: '.', pattern: 'probe', minCount: 1 },
    ],
  })
  console.log(`   ${verifyResult.ok ? '✓' : '✗'} ${verifyResult.passed}/${verifyResult.total} 通过`)
  for (const item of verifyResult.results) console.log(`     ${item.ok ? '✓' : '✗'} [${item.kind}] ${item.detail}`)
  assert(verifyResult.ok, '本地验收应当全过')

  console.log('== 6. 验收器要能识别失败')
  const failResult = await tools.get('agent_verify').execute({
    cwd: workDir,
    checks: [{ kind: 'file', path: 'probe.txt', contains: '一定不存在的片段' }],
  })
  assert(failResult.ok === false, '内容不匹配时必须判失败')
  console.log(`   ✓ 正确判负：${failResult.results[0].detail}`)

  const cmdResult = await tools.get('agent_verify').execute({
    cwd: workDir,
    checks: [
      { kind: 'command', command: 'echo commander-ok' },
      { kind: 'command', command: 'exit 3', expectExitCode: 3 },
    ],
  })
  assert(cmdResult.ok, `命令检查应当通过：${JSON.stringify(cmdResult.results.map((r) => r.detail))}`)
  console.log(`   ✓ 命令检查通过：${cmdResult.results.map((item) => item.detail).join(' / ')}`)

  if (live) {
    console.log('== 7. 真的派活给 qoder-cn')
    const target = path.join(workDir, 'live.txt')
    const dispatch = await tools.get('agent_dispatch').execute({
      agent: 'qoder-cn',
      cwd: workDir,
      label: '冒烟：写一个文件',
      prompt: `在 ${workDir} 下创建 live.txt，内容只写 SMOKE-OK。只做这一件事，完成后一句话汇报。`,
    })
    console.log(`   → 任务 ${dispatch.taskId}`)
    assertValue(dispatch, tools.get('agent_dispatch').output.schema, 'agent_dispatch.output')
    const report = await tools.get('agent_report').execute({ taskId: dispatch.taskId, wait: true, timeoutMs: 300000 })
    assertValue(report, tools.get('agent_report').output.schema, 'agent_report.output')
    tools.get('agent_report').output.render({}, report)
    console.log(`   状态 ${report.status} · ${report.toolCalls.length} 个动作 · ${report.durationMs}ms`)
    for (const call of report.toolCalls) console.log(`     · ${call.name} ${call.detail}`)
    if (report.summary.length > 0) console.log(`   结论：${report.summary}`)

    const trace = await tools.get('agent_trace').execute({ taskId: dispatch.taskId, limit: 5 })
    assertValue(trace, tools.get('agent_trace').output.schema, 'agent_trace.output')
    tools.get('agent_trace').output.render({}, trace)

    const statusOne = await tools.get('agent_status').execute({ taskId: dispatch.taskId })
    assertValue(statusOne, tools.get('agent_status').output.schema, 'agent_status.output(单个)')

    const verified = await tools.get('agent_verify').execute({
      taskId: dispatch.taskId,
      checks: [{ kind: 'file', path: 'live.txt', contains: 'SMOKE-OK' }],
    })
    assertValue(verified, tools.get('agent_verify').output.schema, 'agent_verify.output')
    console.log(`   ${verified.ok ? '✓ 验收通过' : '✗ 验收失败'}：${verified.results[0]?.detail ?? ''}`)
    assert(existsSync(target), '智能体应该建出 live.txt')
    assert(readFileSync(target, 'utf8').includes('SMOKE-OK'), 'live.txt 内容不符')
    assert(verified.ok, '验收应当通过')
  }

  console.log(`== ${live ? 8 : 7}. 控制台`)
  // 控制台开在 config.console.port 起第一个空闲端口；冒烟测试里直接按
  // 「页面能出来 + 接口形状对」判断，不依赖具体端口号。
  const consoleUrl = await waitForConsole(dataDir)
  assert(consoleUrl !== null, '控制台应该能起来（apply() 里自动启动）')
  const page = await fetch(consoleUrl)
  const html = await page.text()
  assert(page.status === 200, `控制台首页应当是 200，实际 ${page.status}`)
  assert((page.headers.get('content-type') ?? '').includes('text/html'), '控制台首页应当是 HTML')
  assert(html.includes('智能体控制台'), '控制台首页应当有标题')
  const overview = await (await fetch(consoleUrl + 'api/overview')).json()
  assert(Array.isArray(overview.agents) && overview.agents.length > 0, '概览要列出适配器')
  assert(typeof overview.stats?.running === 'number', '概览要给出并发状态')
  assert(Array.isArray(overview.tasks), '概览要给出任务列表')
  const missing = await fetch(consoleUrl + 'api/tasks/根本不存在的任务')
  assert(missing.status === 404, `不存在的任务应当 404，实际 ${missing.status}`)
  const noPrompt = await fetch(consoleUrl + 'api/dispatch', { method: 'POST', body: '{}' })
  assert(noPrompt.status === 400, `缺 prompt 应当 400，实际 ${noPrompt.status}`)
  console.log(`   ✓ 控制台 ${consoleUrl} 首页 ${html.length} B、${overview.agents.length} 个适配器、边界情况回 404/400`)

  rmSync(workDir, { recursive: true, force: true })
  console.log('\n全部通过。')
}

/**
 * 等控制台起来：apply() 里是异步启动的，而且 /api/overview 要真去探活
 * （qoder-cn 的 probe() 会 spawn 一次 CLI 查版本，冷启动要一两秒），
 * 所以给足重试窗口，别一次没命中就断言失败。
 */
async function waitForConsole() {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    for (let port = 4790; port < 4830; port += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/overview`, { signal: AbortSignal.timeout(6000) })
        if (res.ok) {
          const body = await res.json()
          if (Array.isArray(body.agents)) return `http://127.0.0.1:${port}/`
        }
      } catch {
        // 端口上没人，或者探活还没回，试下一个
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

/**
 * DSH 的 JSON Schema 校验器（JsonSchemaError）只接受单一 type 字符串。
 * 实测过：`type: ['number','null']` 会让整个插件加载失败，
 * 报 "schema.properties.…type must be a single type string (type arrays are not supported)"。
 * 运行时返回 null 是允许的 —— schema 里只写那个非 null 的类型就行。
 */
function assertStrictSchema(schema, path) {
  if (schema === null || typeof schema !== 'object') return
  if (Array.isArray(schema.type)) throw new Error(`${path}.type 是类型数组，DSH 不接受：${JSON.stringify(schema.type)}`)
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[keyword] !== undefined) throw new Error(`${path}.${keyword} DSH 的校验器不支持，改用可选字段 + 单一类型`)
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) assertStrictSchema(child, `${path}.properties.${key}`)
  if (schema.items !== undefined) assertStrictSchema(schema.items, `${path}.items`)
  for (const [key, child] of Object.entries(schema.definitions ?? {})) assertStrictSchema(child, `${path}.definitions.${key}`)
}

/**
 * 轻量输出校验器：照着 DSH 宿主的规矩挑刺。
 * 宿主只认单一 type 字符串，且 null 一律不合法 —— 这两条踩过一次就够。
 */
function assertValue(value, schema, path) {
  if (schema === null || typeof schema !== 'object') return
  if (value === null) throw new Error(`${path} 是 null，DSH 的输出校验器不接受 null`)
  const type = schema.type
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} 应该是 string，实际是 ${typeof value}`)
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} 应该是有限 number，实际是 ${JSON.stringify(value)}`)
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(`${path} 应该是 integer，实际是 ${JSON.stringify(value)}`)
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} 应该是 boolean，实际是 ${JSON.stringify(value)}`)
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} 应该是 array，实际是 ${typeof value}`)
    value.forEach((item, index) => assertValue(item, schema.items ?? {}, `${path}[${index}]`))
  } else if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 应该是 object，实际是 ${typeof value}`)
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) throw new Error(`${path}.${key} 是必填，但没给`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (schema.properties?.[key] === undefined) throw new Error(`${path}.${key} 不在 schema 里（additionalProperties: false）`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) assertValue(value[key], child, `${path}.${key}`)
    }
  }
}

/** 给 render 自检用的最小合法返回值。 */
function emptyFor(toolName) {
  switch (toolName) {
    case 'agent_list':
      return { adapters: [], defaultAgent: 'qoder-cn' }
    case 'agent_dispatch':
      return { taskId: 't', agent: 'qoder-cn', channel: 'cli', status: 'queued', queued: false, dir: '/tmp/t', message: '' }
    case 'agent_status':
      return { tasks: [], running: 0, queued: 0 }
    case 'agent_report':
      // 这里的空值形态必须与 schema 声明的类型一致：DSH 的输出校验器不接受 null
      return {
        taskId: 't', agent: 'qoder-cn', channel: 'cli', status: 'queued', label: '', cwd: '', durationMs: 0,
        sessionId: '', numTurns: 0, summary: '', error: '', screenshot: '', guiSessionFile: '',
        toolCalls: [], lastWords: '', denials: [], eventCount: 0, stillRunning: true,
      }
    case 'agent_trace':
      return { taskId: 't', fromIndex: 0, total: 0, nextIndex: 0, lines: [] }
    case 'agent_verify':
      return { ok: true, passed: 0, total: 0, cwd: '', results: [], changes: [], note: '' }
    case 'agent_cancel':
      return { taskId: 't', cancelled: true, message: '' }
    case 'agent_login':
      return {
        agent: 'workbuddy', action: 'start', ok: false, authUrl: '', state: '',
        savedTo: '', account: '', message: '',
      }
    default:
      return {}
  }
}

main().catch((error) => {
  console.error('\n冒烟测试失败：', error)
  process.exitCode = 1
})