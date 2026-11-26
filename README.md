# dsh-agent-commander

指挥本机的别的智能体干活 —— 从 DeepSeek Harness 里派活、看进度、验收。

**它解决的问题**：你手边有好几个 AI 编程智能体（Qoder CN、WorkBuddy……），但每次都得手动切窗口、敲提示词、盯着看有没有做完、再自己检查改对没有。这个插件把这一整套变成 DSH 里的几个工具调用：**派活 → 盯进度 → 拿证据验收**。

```
你 → DSH(指挥) → agent_dispatch ──→ Qoder CN / WorkBuddy 真的动手
                        ↓
                  agent_report  ← 它做了什么、说了什么
                        ↓
                  agent_verify  ← 文件/命令/git 的真实状态
```

## 已支持

| 智能体 | 驱动方式 | 状态 |
| --- | --- | --- |
| **Qoder CN** | `qoderclicn` 无头模式（`-p --output-format stream-json`） | ✅ 已实测跑通 |
| **WorkBuddy** | 桌面端自带 `codebuddy` CLI（`resources/app.asar.unpacked/cli/bin/codebuddy`） | ⚙️ 已接通，用 `agent_login` 登录后可用 |

设计上适配器是插槽式的：豆包、千问等后续按同一接口加，不改工具层。

## 实测记录

一次真实的委派，全程没人工介入：

```
agent_dispatch({ agent: "qoder-cn", cwd: "D:/proj", prompt: "做一个单文件科技感网页" })
  → succeeded · 10m47s · 48 轮 · 47 个动作
  → Write index.html(52KB) + 8 次 Edit + node --check + 无头 Chrome 截图自查
agent_verify → 文件 50.9KB ✓ · 零外链 ✓ · canvas / RAF / 响应式 / 标题 ✓
```

值得注意的是它**自己起了无头 Chrome 截图**看过效果，回头又改了 8 次 —— 这些动作都能在
`agent_trace` 里逐条查到，不必相信它的一句「完成了」。

## 安装

插件目录放进 profile 的依赖里，然后在 bundle 列表启用：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-agent-commander": "link:D:/F-ALL/dsh-agent-commander"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-agent-commander", "..."]
    }
  }
}
```

`cordis.patch.yml` 已带一份可用默认配置，无需额外设置就能用。

## 八个工具

| 工具 | 干什么 |
| --- | --- |
| `agent_list` | 本机能指挥谁、谁真的能用（装没装、登录没登录） |
| `agent_dispatch` | 派活，**立刻返回 taskId**，任务在后台跑 |
| `agent_status` | 看状态，轻量（不读事件流） |
| `agent_report` | 看报告：它做了哪些动作、结论是什么；`wait:true` 可以等到跑完 |
| `agent_trace` | 看完整轨迹（分页），需要查它到底跑了什么命令时用 |
| `agent_verify` | **用证据验收**：文件 / 命令 / git / 目录 |
| `agent_cancel` | 取消还在跑的任务 |
| `agent_login` | 给需要授权的智能体做登录（目前只有 WorkBuddy 需要） |

### 典型用法

```
1. agent_list({})                           # 先看谁在线
2. agent_dispatch({
     agent: "qoder-cn",
     cwd: "D:/my-project",
     prompt: "在 D:/my-project 下把 README 的安装章节补上，只改 README.md"
   })
   → taskId: qoder-cn-20261126T012345-a1b2
3. agent_report({ taskId, wait: true })     # 等它跑完，看它干了什么
4. agent_verify({
     taskId,
     checks: [
       { kind: "file", path: "README.md", contains: "## 安装" },
       { kind: "git", clean: false, hasCommit: false }
     ]
   })
```

## 为什么验收要单独做

智能体会说「已完成」。但它可能：文件没建成、只写了个空壳、写完又删了、或者根本没权限改文件。

所以 `agent_verify` 只看三样东西：

- **文件真的在吗** —— 大小、内容片段、正则
- **命令真的过吗** —— 跑测试、跑构建，看退出码
- **git 真的干净吗** —— 该提交的提交了，该删的删了

```js
// 五类检查
{ kind: "file", path: "src/a.ts", contains: "export function", minBytes: 100 }
{ kind: "absent", path: "tmp/debug.log" }              // 该删的确实不在
{ kind: "command", command: "npm test", expectExitCode: 0, contains: "passing" }
{ kind: "git", repo: ".", clean: true, hasCommit: true, messageContains: "feat:" }
{ kind: "tree", path: "dist", pattern: "\\.js$", minCount: 3 }
```

## 已知坑（都是实测踩出来的）

**Qoder CN 的 `dont_ask` 权限模式不能用。** 它不会询问，而是**静默拒绝一切写操作**：

```
This action needs approval, and the "Don't ask" permission mode does not prompt.
```

文件不会建出来，任务还会「成功」返回。本插件默认用 `bypass_permissions`。

**Qoder CN 每次调用都会打印一条 MCP 配置告警**：

```
Skipped invalid MCP server "mx-ds-mcp": type: Invalid enum value.
Expected 'stdio' | 'sse' | 'http' | 'ws' | 'streamable-http', received 'streamableHttp'
```

来自 `~/.qoder-cn/settings.json` 里 `type` 拼写不合法。不影响干活，插件会把它归到 `notice`，不进摘要。

**WorkBuddy 需要先登录。** 未登录时 CLI 返回 `401 Authentication required`，任务会被标成 failed 并带上原文。
登录用 `agent_login`：它自己走一遍设备码流程（`POST /v2/plugin/auth/state?platform=CLI` 拿链接 → 你在浏览器里登录 → 轮询 token），
成功后把 token 写进 `~/.codebuddy/settings.json` 的 `env.CODEBUDDY_AUTH_TOKEN`，之后派活直接可用。

**Qoder CN 的 Bash 工具在本机会失败**：

```
qoder-bash-owner: line 1: /proc/<pid>/winpid: No such file or directory
Could not record Windows Bash process identity
```

命令根本没执行。它自己会退到 Glob/Read/Write 把活干完（实测如此），所以功能不受影响 ——
但别指望它用 Bash 跑测试，验收条件也别只依赖它跑命令。

**它对 `cwd` 很挑。** 目录不存在时 spawn 报的却是 `spawn <cli 路径> ENOENT`，
极易误判成「CLI 没装」。本插件会先 `mkdir -p` 工作目录，并在失败时明确说是目录问题。

## 配置

```yaml
- insert:
    - id: agent-commander
      name: 'dsh-agent-commander'
      config:
        defaultAgent: qoder-cn
        timeoutMs: 1800000      # 单任务上限，超时先 SIGTERM 再强杀
        graceMs: 5000
        maxConcurrent: 3        # 同时跑几个
        adapters:
          qoder-cn:
            enabled: true
            binary: ''          # 留空自动探测 ~/.qoder-cn/bin/qoderclicn/qoderclicn.exe
            permissionMode: bypass_permissions
            model: ''           # 空 = Auto
```

## 落盘

每次派活的完整轨迹在 `<profile>/agent-commander/tasks/<taskId>/`：

```
meta.json     任务元信息与最终状态
events.jsonl  逐行事件（init / thinking / 工具调用 / 结论 / 用量）
stderr.log    子进程 stderr 原文
```

所以插件重启后历史还在，也能事后翻完整轨迹。

## 开发

```bash
node test/smoke.mjs          # 加载 + 探活 + 验收器自检（不花钱）
node test/smoke.mjs --live   # 额外真的指挥 Qoder CN 写一个文件并验收
```

## 加一个新智能体

在 `lib/adapters/` 下加一个文件，实现三个方法：

```js
export function createMyAdapter(config, globalConfig) {
  return {
    id: 'my-agent',
    label: '我的智能体',
    async probe() { /* 装没装、登录没登录 */ },
    build(task) { /* 返回 { binary, args, cwd } */ },
    parse(line) { /* 一行输出 → 统一事件数组 */ },
  }
}
```

然后在 `index.js` 里 `adapters.register(...)`。如果那个 CLI 也是 Claude Code 系的，`parse` 直接用 `lib/adapters/claude-style.js` 里的 `parseClaudeStyleLine`。

需要授权的那种，再额外实现两个方法（可选）：

```js
async login(options) { /* → { authUrl, state, cancel(), waitFor() } */ },
async logout() { /* 清掉本地凭据 */ },
```

`waitFor()` 成功后应当自己把 token 存到该 CLI 认的位置，这样后续派活就不用再管它。
`lib/adapters/codebuddy-auth.js` 是一个完整的设备码流程参考实现。

## License

MIT