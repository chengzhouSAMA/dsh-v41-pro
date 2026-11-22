# 设计说明与技术契约

适配本机 `@deepseek-ai/dsh@0.2.2-rc.3`。本文件只描述已实现机制；不把模型厂商基准或本地机制测试当成本插件的模型能力提升。

## 1. 责任边界

插件不能改变模型参数、推理训练、上下文容量或视觉输入能力。它负责：

1. 把真实工具结果转成明确证据。
2. 将失败反馈变成有预算的下一步行动。
3. 在上下文压缩与恢复后保留必要的派生索引。
4. 用独立子代理补充方案生成和审查。
5. 可选地调用已注册的更强模型，但不伪装目标存在。

## 2. 当前 DSH 接口

已通过运行时 Inspect 核对：

| 接口 | 形状与用途 |
|---|---|
| `tools/post-execute` | waterfall：`(exec, result, next)`；本包先 `await next()`，保留下游 decision 的所有字段 |
| `tools/result` | 官方只读观察点；旧模块保留 post-execute 观察以兼容其既有测试，新增模块优先使用 `tools/result` |
| `agent/pre-step` | waterfall：`payload` 带 `agent/messages/turn/step/signal/modelSelection`；注入只发生在 `decision.kind === 'enter'` |
| `agent/turn-stopping` | serial；`agent.steer()` 只允许有限次续命，不能形成无限循环 |
| `agent/assistant-stream` | emit；仅检测有限的自述不确定文本，不作为事实判断依据 |
| `agent/created` / `agent/disposed` | 恢复台账与释放按 Agent 隔离的状态 |
| `session/event` | emit；只读取已提交的 `compaction/start/end`，不伪造新 Session 事件 |
| `ctx.tools.register` | 注册工具，提供 `parameters`、`output.schema`、`output.render`、`execute`；在 `ctx.effect()` 中释放 |
| `ctx.shell.resolve/execute` | 真实命令走 DSH shell，保持其沙箱、工作目录、超时与取消语义 |
| `ctx.subagents.startActivation` | 当前子代理 API；`delivery: 'caller'`、检查 `stopReason`、最终 `dispose()` |
| `agent.model.current/select` | 持久模型选择，从下一步生效；仅使用 `resolveModelInfo` 验证后的模型和 effort |
| `ctx.systemPrompt.section` | 简单稳定提示的首选入口；不用 `system-prompt/assemble` 替换整个组装结果 |

参考的当前升级说明：`session-model-selection`、`model-switch-compaction`、`subagent-activations`、`subagent-preset-composition`、`plugin-install-over-installed`、`plugin-engines-dsh`。其他不涉及本包的账号、UI、终端、Schedule 等升级项未用于本次改动。

## 3. 证据判定

`src/core/evidence.js` 集中处理：

- `result.isError` 仅表示工具/基础设施错误，不等于进程退出码。
- 结构化 `value/meta.exitCode` 优先；`[exit code: N]` 是兼容文本入口。
- 结构化退出码与文本标记冲突时 fail-closed。
- 超时、中止、停止、后台移交、信号终止和沙箱拒绝不能算验证通过。
- `requiresTestEvidence()` 识别常见测试命令；对 Node、pytest、Jest/Vitest、TAP、Go 摘要要求实际执行至少一项且无失败。
- 编译/lint 的零退出可以验证编译/lint，但不能证明功能测试通过。
- 失败指纹由工具、脱敏参数、错误类别、归一化摘要计算。无关成功调用不会清除最近失败；新用户输入会清除该链。
- 台账脱敏只覆盖常见显式凭证模式，不承诺发现所有秘密。

## 4. 台账一致性

状态按 Agent 的 `session.id` 隔离，文件/失败/命令有界。恢复 promise 在首次注入前等待，避免旧磁盘内容覆盖新状态。

每次写入在第一次 `await` 前抓取版本与数据快照。保存任务串行执行，完成后只有保存版本仍等于当前版本才清除 dirty；较晚任务因此不会被较早任务吞掉。

这是插件私有缓存，不是唯一事实来源。真正的对话与恢复仍以 DSH Session 日志为准；`appendPluginRecord()` 和自定义 Session 事件没有被使用。

## 5. 工具与子代理

`pro_verify` 使用 `ctx.shell`，不通过 `ctx.subprocess` 绕过沙箱。输出有界，退出码真实，失败不能改写为通过。

`pro_fork` 仅产出方案；`pro_critique` 仅审查。子代理输出为不可信文本，解析失败一律不放行；复审服务故障与“复审发现问题”分开报告。当前 DSH 的工具选择通过 Agent Preset 组合完成，不再伪造旧 `toolFilter`。

## 6. 插件装载与显示

Host-only bundle 无构建依赖。`cordis.patch.yml` 拆成七行，用户 patch 用同 id 整行覆盖。默认升级为 `advise`，不自动假定 `deepseek-v4-pro` 在 provider 上可用。

`locale/zh.json`、`locale/en.json` 提供包级显示元数据；`icon.svg` 是原创校验清单图标。七个子路径行不自动继承包图标，本次没有为每行复制子路径资源。静态资源由自检按文件/JSON 校验，不作为 ESM import。

安装已存在 bundle 时遵循先移除再安装的当前 DSH 规则。`application` 结果、真实工具注册和新会话行为分别验证，不能只看文件存在或版本号。

## 7. 评测边界

`npm test`：单元和回归。
`npm run selfcheck`：包契约与资源。
`npm run reliability`：6 个固定的插件机制场景，实际调用证据、验证器、卡住检测与恢复；不是模型 benchmark。

比较模型时必须冻结任务、provider、提示、权限、时间/步骤/费用预算、重试和评审器；报告所有运行的分母，区分自主成功、人工协助、失败、超时和无效。未做这种实验时，只能声明机制改进，不能声称超过 DeepSeek V4.1 Pro 或任何其他模型。
