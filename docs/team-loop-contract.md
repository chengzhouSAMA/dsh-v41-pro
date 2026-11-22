# v41pro 团队协作契约（复盘 / 校准 / 验收 / 精简）

本文件是四个并行子任务的唯一接口约定。**先读完整份再动手**。工作区：
`C:\Users\35968\Desktop\伪·v4.1pro插件`。

## 0. 总目标

给 DSH 插件 `dsh-v41-pro` 增加四个能力，默认开启、可配置关掉：

1. **验收闸门**（acceptance）：为任务定义可执行验收标准；收尾时未验证则强制续命一次。
2. **预测校准账本**（calibration）：交付前记录成功概率/预计耗时，事后结算；统计 Brier、过度自信、耗时误差。
3. **复盘与规则库**（retro）：失败或完成后写复盘，沉淀可复用规则；后续任务按关键词命中并注入提醒。
4. **代码精简审查**（shrink）：写完代码后必须逐个文件检查「是否能更短」，删/并/保留都要给理由；未审查不得收尾。

## 1. 文件所有权（硬约束）

| 角色 | 只能写 |
| --- | --- |
| agent-acceptance | `src/acceptance.js`、`test/acceptance.test.mjs` |
| agent-calibration | `src/calibration.js`、`test/calibration.test.mjs` |
| agent-retro | `src/retro.js`、`test/retro.test.mjs` |
| agent-shrink | `src/shrink.js`、`test/shrink.test.mjs` |
| lead（主代理） | 其余全部：`index.js`、`package.json`、`cordis.patch.yml`、`README.md`、`scripts/*`、`src/core/persist.js`、`test/fake-ctx.mjs`、`docs/*` |

- 不要改别人的文件，不要改共享文件，不要新增依赖，不要 `git` 操作，不要重启 DSH。
- 运行中 DSH 通过 symlink 加载本工作区；只改自己负责的两个文件，避免触发不必需的插件重载。

## 2. 模块骨架（必须一模一样地满足）

```js
import { makeLogger } from './core/config.js'   // makeLogger(ctx, name)
import { bool, num, str } from './core/config.js'
import { createAgentStore, sessionKey } from './core/state.js'
import { createNotice, createSnapshot } from './core/message.js'
import { SessionJson, GlobalJson, v41Dir, makeId } from './core/persist.js'

export const name = 'v41pro-acceptance'          // 与 patch 行 name 一致
export const inject = ['tools', 'commands', 'shell'] // 按需；calibration/retro 不要 shell
export const DEFAULTS = { enabled: true, gate: true, maxNudges: 1 }

export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = { ...DEFAULTS, ...rawConfig }
  if (!bool(cfg.enabled, true)) return
  // ...注册
}

// 供测试：不依赖 cordis 运行时也能构造状态
export function __createState(agent, cfg) { ... }
```

- **不要 default export**；`apply` 同步返回，不 await。
- 所有注册必须包在 `ctx.effect(() => ..., '标签')` 里，返回 disposer。
- 配置非法时抛 `Error`，不要静默降级；单个监听器内部异常必须 try/catch + `logger.warn`，不能把宿主事件打断。

## 3. 事件签名（已按真实 DSH 0.2.2-rc.5 核对）

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision?.kind !== 'enter') return decision
  // payload: { agent, turn, step, messages, signal, modelSelection? }
  return { ...decision, messages: [snapshot, ...decision.messages] }
})

ctx.on('tools/post-execute', async (exec, result, next) => {
  const downstream = await next()
  // exec: { name, args, agent }；result: 工具结果
  return downstream
})

ctx.on('agent/turn-stopping', ({ agent }) => {
  // serial；只能 agent.steer(createNotice(...)) 续命
})

ctx.on('agent/created', ({ agent }) => {})   // 可异步 load
ctx.on('agent/disposed', ({ agent }) => {})  // 清理 + flush
```

- 收尾门禁**每回合最多 steer 一次**：用 `state.nudges` + `state.turn` 记，`agent/pre-step` 的 `payload.turn` 变化时清零。
- `payload.messages` 可能为空；取用户原文用 `blocksToText`（`src/core/util.js`）并对 `source.kind === 'user'` 过滤。

## 4. 持久化

```js
const store = new SessionJson(cfg.dir, 'acceptance')   // 文件名 <safeKey>.acceptance.json
await store.load(agent.session.id, fallback)
await store.save(agent.session.id, data)

const global = new GlobalJson(cfg.dir, 'rules', { rules: [] })
await global.update(data => { data.rules.push(rule); return rule })
```

- 默认目录：`v41Dir('acceptance')`、`v41Dir('calibration')`、`v41Dir('retro')`、`v41Dir('shrink')`；测试传临时目录。
- 写入必须 `await` 完成后再返回工具结果。
- 会话加载：`agent/created` 里置 `state.ready` promise；工具/事件里 `await state.ready`。
- 未知/损坏 JSON 按 `load` 的 fallback 处理；不要抛到宿主。

## 5. 工具与命令注册

```js
ctx.effect(() => ctx.tools.register({
  name: 'acceptance',
  description: '管理验收标准；define/check/list/complete/clear。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['define', 'check', 'list', 'complete', 'clear'] },
      criteria: { type: 'array', items: { type: 'object', properties: {...}, required: [...] } },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', ... },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) { /* exec.agent / exec.signal */ },
}), 'v41pro-acceptance')
```

```js
ctx.effect(() => ctx.commands.register({
  name: 'accept',
  description: '查看或清理验收标准',
  input: { hint: 'status | clear | check' },
  async handler({ agent, rawInput, signal }) {
    return { kind: 'success', text: '...' }   // 失败用 { kind: 'error', text }
  },
}), 'v41pro-acceptance.command')
```

- 命令名不带 `/`。成功/失败用 `kind: 'success' | 'error'`。
- 工具返回**结构化对象**（含 `text` 供渲染），不要返回裸字符串。

## 6. 文案

- 默认中文；配置 `language: 'en'` 时至少让门禁提示可读（可只做简短英文分支）。
- 门禁/提醒文案必须包含：**具体证据**（哪几个文件/哪条标准）、**有限下一步**（1–3 个动作）、**这不是用户新消息**（用 `sourceNote(language)`，见 `src/core/text.js`）。
- `createNotice({ kind: name, summary, text })` 的 `kind` 用模块名；`summary` ≤ 120 字符。
- 不要长篇说教；每条 ≤ 6 行。

## 7. 测试（必须自己跑绿）

- 命令：`node --test test/<你的文件>.test.mjs`；每文件至少 6 个用例，覆盖正常路径 + 边界 + 门禁只触发一次 + 持久化重载。
- 用 `test/fake-ctx.mjs`：
  - `createFakeCtx({ shell })` → `{ ctx, tool, command, emit, dispose }`
  - `createFakeAgent('session-1')` → `agent.steered[]`、`agent.model`、`agent.session.id`
  - `createToolExec({ name, args, agent })`
  - pre-step：`ctx.call('agent/pre-step', [{ agent, turn, step, messages: [], signal }], { kind: 'enter', messages: [] })`
  - turn-stopping：`emit('agent/turn-stopping', { agent, turn: 1 })`
  - post-execute：`ctx.call('tools/post-execute', [exec, OK_RESULT], { kind: 'accept' })`
- 持久化测试用 `fs.mkdtempSync(path.join(os.tmpdir(), 'v41pro-xxx-'))` 作 `dir`，结束后 `rmSync(recursive)`。
- 不联网、不调模型、不依赖时间精度（用 `>=`/正则，别断言具体时间戳）。
- 测试全绿前不要汇报完成；汇报时贴命令与通过数。

## 8. 各模块需求

### 8.1 acceptance（`src/acceptance.js`）

- `inject = ['tools', 'commands', 'shell']`；配置：`enabled`、`gate`（默认 true）、`maxNudges`（1）、`dir`、`language`、`maxCriteria`（20）、`timeoutMs`（120000）。
- 状态：`{ criteria: [{ id, text, type: 'cmd'|'file'|'manual', command?, path?, expectExitCode=0, status: 'pending'|'verified'|'failed', evidence, checkedAt }], nudges, turn, ready }`。
- 工具 `acceptance`：
  - `define`：`criteria` 数组，每项必须有 `text`，`type` 默认 `cmd`；`cmd` 必须有 `command`，`file` 必须有 `path`；默认追加，`replace: true` 时替换；超上限报错。
  - `check`：执行所有 `cmd`（`ctx.shell.resolve({ command, timeoutMs, signal, sandboxPolicy: ctx.sandboxPolicy?.resolve({ session: exec.agent.session }) })` → `ctx.shell.execute(spec)` → `await handle.result()`；`exitCode === expectExitCode && !timedOut && !aborted` 为通过）和 `file`（存在且 size>0）；`manual` 保持 pending。返回每条 status + 证据摘要。
  - `list`：状态清单。
  - `complete`：全部 `verified` 才成功；否则 `ok:false` 并列出未验证项（≤5）。
  - `clear`：清空。
- 收尾门禁：`gate && criteria.length>0 && !allVerified && nudges<maxNudges` → `agent.steer(createNotice(...))`，列出未验证项，要求现在 `check`/`complete`，或明确说明阻碍；`nudges` +1。每回合重置。
- pre-step：进入新回合时若存在 pending 标准，注入一条 snapshot（≤5 项 + 计数），不要每步重复。
- 命令 `accept`：`status`（默认）/`check`/`clear`。
- 测试：cmd 通过/失败、file 存在/缺失、complete 拒绝、门禁一次、reload 后状态还在。

### 8.2 calibration（`src/calibration.js`）

- `inject = ['tools', 'commands']`；配置：`enabled`、`dir`、`language`、`cap`（500）。
- 全局记录 `{ version: 1, records: [...] }`：`{ id, session, task, probability, minutes, risks, tags, createdAt, outcome?, actualMinutes?, settledAt?, note? }`。
- 工具 `forecast`：`{ task, probability, minutes?, risks?, tags? }`；`probability ∈ [0,1]` 必须；返回 id、当前未结算数。
- 工具 `settle`：`{ outcome: 'success'|'failure'|'partial', id?, actual_minutes?, note? }`；不给 id 时结算本会话最近一条未结算；`partial` 不计入 Brier（单独计数）。
- 纯函数导出（测试直接测）：`brierScore(records)`（只算 success=1/failure=0 且已结算）、`meanAbsError(records)`（有 actualMinutes 的）、`summarize(records)` → `{ n, open, brier, overconfidence, maeMinutes, partial }`。
- 命令 `calibration`：结算数/未结算数、Brier、过度自信（平均预测-实际成功率）、耗时 MAE、最近 5 条。
- 不注册 turn-stopping 门禁。
- 测试：概率校验、结算最近一条、Brier 数学值、MAE、跨会话持久化重载、partial 排除。

### 8.3 retro（`src/retro.js`）

- `inject = ['tools', 'commands']`；配置：`enabled`、`dir`、`language`、`maxRules`（200）、`injectRules`（true）、`maxInjected`（3）。
- 复盘存会话文件 `$dir/<session>.retro.json`：`{ version: 1, items: [{ id, at, summary, rootCause, lesson, tags, ruleId? }] }`，上限 200。
- 规则存全局 `rules.json`：`{ version: 1, rules: [{ id, text, tags, scope, hits, createdAt, updatedAt }] }`，上限 `maxRules`，按规范化文本去重（命中已存在则 hits+1 并返回 `deduped:true`）。
- 工具 `retro`：`{ summary, root_cause, lesson, tags?, rule? }`；三个必填非空；`rule` 存在时同时写规则，返回 `{ id, ruleId?, deduped }`。
- 工具 `rules`：`{ action: 'list'|'remove', id?, query? }`；`list` 最多 20 条，按 hits/updatedAt 排序；`remove` 按 id。
- 命令 `retro`：最近 3 条复盘 + 一条填写模板；命令 `rules`：列表；`rules remove <id>`。
- pre-step 注入：进入回合时取 `payload.messages` 的用户文本，`matchRules(rules, text, limit)` 按标签 + 中英文词重叠打分（导出该函数供测试）；命中才注入 1 条 snapshot（≤3 条规则，每条 ≤120 字），同一回合只注入一次；命中计数异步累加，失败不影响请求。
- 不注册收尾门禁（默认）。
- 测试：必填校验、规则去重、remove、`matchRules` 命中/不命中、pre-step 只命中才注入、reload。

### 8.4 shrink（`src/shrink.js`）

- `inject = ['tools', 'commands']`；配置：`enabled`、`gate`（true）、`maxNudges`（1）、`dir`、`language`、`codeExtensions`（`.js .mjs .cjs .ts .tsx .jsx .py .go .rs .java .kt .c .cc .cpp .h .cs .rb .php .swift .sh .ps1`）、`maxFiles`（20）。
- 状态：`{ edited: Map<path, { firstAt, lastAt, count }>, reviewedAt, reviewed: [{ file, category, action, detail }], nudges, turn, ready }`。
- 编辑追踪：`tools/post-execute` 中，工具名属于编辑类（`edit`、`write`、`apply_patch`、`multi_edit`、`notebook_edit`、`str_replace*` 等，做成常量）且 `exec.args` 里有 `path`/`file_path`/`filePath`/`file`/`files`，且扩展名在 `codeExtensions` 里 → 记入本轮。
- 工具 `code_shrink`：`{ files?: string[], findings?: [{ file, category, action: 'removed'|'merged'|'kept', detail }], reason?, allow_keep_all?: boolean }`。
  - `files` 省略时取本轮编辑过的代码文件（最多 `maxFiles`）。
  - 每个 file 必须至少一条 finding；`action:'kept'` 必须有非空 `detail`（理由）。缺覆盖直接报错，不记录。
  - 返回 `{ ok, files, linesBefore, linesAfter, saved, findings }`（行数从磁盘读；文件不存在按 0 计）。
  - 记录 `reviewedAt = Date.now()`，清空 `edited`。
- 收尾门禁：本轮有未审查的代码编辑（`edited.size>0`）且 `nudges<maxNudges` → steer 一次：点名文件（≤5）、要求逐个给出删/并/保留理由，并说明「保留也要理由」。每回合重置。
- 命令 `shrink`：`status`（默认）显示待审查文件 + 上次审查统计。
- 纯函数导出：`countLines(text)`、`isCodeFile(path, exts)`、`summarizeFindings(findings)`。
- 测试：编辑追踪只收代码文件、门禁一次、无 findings 拒绝、kept 无理由拒绝、行数统计、审查后门禁消失。

## 9. 交付报告格式（回给 lead）

1. 改了哪两个文件；2. 注册的工具/命令/监听器清单；3. 测试命令与通过数；4. 已知限制/未做项；5. 是否触碰了范围外文件（应为「没有」）。

完成后用 `team_task_update` 把自己的任务标为 completed。遇到契约冲突或宿主 API 不符，发消息给 lead，不要自行改共享文件绕过。
