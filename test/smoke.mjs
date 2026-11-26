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
    // render 必须能接受空结果而不崩
    const probe = definition.output.render({}, emptyFor(toolName))
    assert(Array.isArray(probe) && probe[0]?.type === 'text', `${toolName} 的 render 没返回 text`)
  }
  console.log('   ✓ 所有工具的描述、参数、输出、渲染都成形')

  console.log('== 3. 探活')
  const listResult = await tools.get('agent_list').execute({})
  for (const adapter of listResult.adapters) {
    const flag = adapter.available ? (adapter.loggedIn === false ? '⚠' : '✓') : '✗'
    console.log(`   ${flag} ${adapter.id}: ${adapter.detail}`)
  }
  assert(listResult.adapters.length >= 2, '应该至少有两个适配器')

  console.log('== 4. 空状态渲染')
  const statusResult = await tools.get('agent_status').execute({})
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
    const report = await tools.get('agent_report').execute({ taskId: dispatch.taskId, wait: true, timeoutMs: 300000 })
    console.log(`   状态 ${report.status} · ${report.toolCalls.length} 个动作 · ${report.durationMs}ms`)
    for (const call of report.toolCalls) console.log(`     · ${call.name} ${call.detail}`)
    if (report.summary !== null) console.log(`   结论：${report.summary}`)

    const verified = await tools.get('agent_verify').execute({
      taskId: dispatch.taskId,
      checks: [{ kind: 'file', path: 'live.txt', contains: 'SMOKE-OK' }],
    })
    console.log(`   ${verified.ok ? '✓ 验收通过' : '✗ 验收失败'}：${verified.results[0]?.detail ?? ''}`)
    assert(existsSync(target), '智能体应该建出 live.txt')
    assert(readFileSync(target, 'utf8').includes('SMOKE-OK'), 'live.txt 内容不符')
    assert(verified.ok, '验收应当通过')
  }

  rmSync(workDir, { recursive: true, force: true })
  console.log('\n全部通过。')
}

/** 给 render 自检用的最小合法返回值。 */
function emptyFor(toolName) {
  switch (toolName) {
    case 'agent_list':
      return { adapters: [], defaultAgent: 'qoder-cn' }
    case 'agent_dispatch':
      return { taskId: 't', agent: 'qoder-cn', status: 'queued', queued: false, dir: '/tmp/t', message: '' }
    case 'agent_status':
      return { tasks: [], running: 0, queued: 0 }
    case 'agent_report':
      return {
        taskId: 't', agent: 'qoder-cn', status: 'queued', label: '', cwd: '', durationMs: null,
        sessionId: null, numTurns: null, summary: null, error: null, toolCalls: [], lastWords: '',
        denials: [], eventCount: 0, stillRunning: true,
      }
    case 'agent_trace':
      return { taskId: 't', fromIndex: 0, total: 0, nextIndex: 0, lines: [] }
    case 'agent_verify':
      return { ok: true, passed: 0, total: 0, cwd: '', results: [], changes: [], note: '' }
    case 'agent_cancel':
      return { taskId: 't', cancelled: true, message: '' }
    default:
      return {}
  }
}

main().catch((error) => {
  console.error('\n冒烟测试失败：', error)
  process.exitCode = 1
})