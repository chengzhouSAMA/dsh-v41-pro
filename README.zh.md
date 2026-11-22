# V4.1 Pro

**中文** | [English](README.md)

> 会话被压缩，昨夜验证过的结论只剩一句“应该没问题”。
> 模型没有变笨；先丢的是工程记忆。

V4.1 Pro 不训练模型，也不假装让它更聪明。它把该记住的目标、该核对的证据、该追问的失败，钉回它们该在的位置——然后要求下一次回答仍然站得住。

这是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件包：17 个 Host 模块、一个 Client 思考菜单，一套从发散到透彻的推理控制，以及“验收 → 校准 → 复盘 → 精简”的工程闭环。另含语言 / 文学 Skill、长篇小说工作区与全模态媒体工具。

![version](https://img.shields.io/badge/version-1.11.0-4B5BD6)
![tests](https://img.shields.io/badge/tests-189%20passing-2EA043)
![license](https://img.shields.io/badge/license-MIT-2EA043)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.5-4B5BD6)

## 它解决什么

- **证据**：验证看进程退出码、真实测试摘要和文件事实，不看模型自评。失败、超时、零测试与“运行过”都不会被写成“已通过”。
- **记忆**：目标、改动、命令结果与失败原因写入有界、原子保存的台账；会话恢复后重建，而不是靠上下文里残留的一句话。
- **追问**：复杂任务先发散、再聚焦；需要时进入透彻模式追问根因与反例，或调用 Reasoning Max 3.0 做多路径搜索与交叉验证。
- **闭环**：交付前先定义可执行验收；先记预测概率，事后结算；失败沉淀为规则；写完代码强制检查还能不能更短。

## 快速开始

要求：DSH `0.2.2-rc.5`（当前验证版本）、Node.js `>=20`；用 `install.mjs --install` 时需要 pnpm。

```bash
git clone https://github.com/chengzhouSAMA/dsh-v41-pro.git
cd dsh-v41-pro
node install.mjs --dry-run     # 先看清会改哪个 profile
node install.mjs --install     # 写入 link: 依赖并执行 pnpm install
```

也可以在 DSH 的 **插件 → 添加插件** 中直接选择本目录。两种方式不要混用。`install.mjs` 只改 profile 的 `package.json`，可逆：

```bash
node install.mjs --uninstall
```

安装或更新后，若新增了 patch 行，需要重启 DSH（或重新加载 Host）；只改已有模块实现时，DSH 的热重载通常已足够。Client 菜单若未出现，刷新当前 DSH 页面，不要另起服务器。

## 思考模式

选中插件后，点击输入框旁的模型菜单，找到 **思考模式**；也可以直接发送命令：

| 命令 | 行为 |
|---|---|
| `/thinking auto` | 先发散拆解，再聚焦执行；连续两次工具失败时有限回溯，任务内最多两次 |
| `/thinking divergent` | 固定发散，实际请求档位至少 `low` |
| `/thinking focused` | 固定聚焦，实际请求档位至少 `high` |
| `/thinking thorough` | 固定透彻，严格使用 `max`；追问根因、核验假设与反例、交叉验证 |
| `/thinking off` | 关闭本会话的模式控制，恢复本模块调整前的档位 |
| `/thinking status` | 查询当前模式与阶段 |

透彻模式要求模型能力表明确声明 `max`。不支持时直接报错并保留原始输入，不用 `high`、`xhigh` 或自定义最高档冒充。模式会随会话命令日志恢复；发散、聚焦与自动模式保留用户已选的更高强度。

### Reasoning Max 3.0

`thinking` 内置的推理编排层，移植自 Python 单文件版 `DSH Reasoning Max 3.0`，由 `reasoning_max` 工具与 `/reasoning-max` 命令调用。它组织多次模型调用，不改变模型权重或单次回答能力。

- **分层算力**：按问题长度与关键词选 `low / medium / high`。低档单候选 + 评审，置信 ≥ 0.7 直接交答案；中/高档并行候选 + 步骤树 + 综合。
- **多路径**：4 个视角并行生成（独立主解、替代路径、反例与边界、实践验证），再交独立评审。
- **MCTS**：UCT 选择、并行扩展、PRM 逐步打分、按路径价值回传、低分剪枝；置信、平台期、预算或计划上限触发收束。
- **PRM 与评审**：LLM-as-judge 多次采样取均值与标准差；最终评审取最严结论、平均置信度并去重问题。
- **预算与路由**：token 粗估与墙钟时间预算；多模型 UCB1 + ε 路由，奖励回写 `router.json`。
- **RL 日志**：每次求解写 `rl.jsonl` 与 `audit.jsonl`；`/reasoning-max export` 导出 `prm_steps.jsonl`、`preference_pairs.jsonl`、`sft_best.jsonl`。
- **与 DSH 档位的关系**：`low/medium/high` 是编排预算，不是 DSH 推理档；实际调用按模型声明映射（low→≥low、medium→≥high、high→max，缺失时降到已声明的最高档）。
- **诚实边界**：PRM 是带噪声的 LLM 评审代理；token 是粗估；RL 层只学路由并导出数据，不微调模型；一次求解会多次调用模型，简单问题不要用。

状态目录：`$DSH_HOME/v41pro/reasoning-max/`。

## 工程闭环

| 模块 | 能力 |
|---|---|
| `acceptance` | 可执行验收标准：`cmd` 走真实 shell 取退出码，`file` 检查存在且非空，`manual` 需人工确认；收尾仍有未验证项时续命一次 |
| `calibration` | 交付前 `forecast` 记概率/耗时，事后 `settle`；统计 Brier、过度自信与耗时 MAE |
| `retro` | 复盘写现象、根因、教训，并沉淀可复用规则；后续任务按关键词命中并回注 |
| `shrink` | 写完代码必须逐个文件给出「删 / 并 / 保留」的理由；行数由磁盘实测 |

对应工具：`acceptance`、`forecast`、`settle`、`retro`、`rules`、`code_shrink`；命令：`/accept`、`/calibration`、`/rules`、`/shrink`。

门的强制力来自收尾时 `agent.steer` 续命一次，**不是权限锁**。模型仍可能敷衍一句话；`code_shrink` 记录的是它给出的理由与磁盘行数，不代表做了语义级最优精简。规则匹配是关键词召回，不是语义理解。

## 全部模块

| 模块 | 能力 |
|---|---|
| `escalator` | 重复调用、连续失败、跨步骤相同失败、反复编辑与漂移检测；可仅提醒或临时切换模型 |
| `ledger` | 目标、改动、真实命令结果与失败摘要持久化；版本化、串行、原子写入 |
| `verifier` | `pro_verify` 与收尾闸门；区分失败、超时、零测试与有效通过 |
| `acceptance` | 可执行验收标准与收尾闸门 |
| `tempo` | 步数、挂钟时间、工具失败预算，限制自动干预 |
| `forker` | 并行生成独立方案候选，由主代理选择并只执行一个 |
| `critic` | 独立、只读、fail-closed 复审；复审没跑成不会伪装成通过 |
| `cartographer` | 压缩后按真实读写记录重建文件索引与未通过验证的证据 |
| `calibration` | 预测校准账本 |
| `retro` | 复盘与规则库 |
| `shrink` | 代码精简审查 |
| `language` | 按需语言优化 Skill：目标、交付物、验收、命题保留、证据分级 |
| `fiction` | 按需文学写作 Skill：场景目标、人物动机、知识边界、能力代价、伏笔与章末钩子 |
| `novel` | 长篇小说工作区：大纲 + 数据库，每回合注入现状卡，用户要求可记录、可废弃 |
| `thinking` | 发散 / 聚焦 / 透彻 / 自动阶段切换；内置 Reasoning Max 3.0 |
| `ethical-conduct` | 常驻行为准则：每次模型请求自动加载完整正文，不受思考开关影响 |
| `omni` | 全模态媒体：环境探测、视频抽帧/扫描、音频分析/转写/合成/剪辑、视频合成、音轨提取、图片生成 |

## 常用工具

| 工具 | 用途 |
|---|---|
| `pro_verify` | 真正执行命令并返回退出码，作为验证证据 |
| `pro_fork` | 并行生成多个方案候选（会创建子会话，产生模型费用） |
| `pro_critique` | 独立只读复审，只挑错，fail-closed |
| `pro_novel` | 管理长篇小说工作区 |
| `reasoning_max` | 多层推理编排（简单问题不要调用） |
| `omni_*` | 11 个媒体工具：探测、抽帧、扫描、音频、合成、图片生成等 |

子代理工具会创建真实子会话。机械修改或事实查询不应使用。

## 配置

模块配置采用整行替换；未填字段使用默认值。例如临时升级模型：

```yaml
- id: v41pro-escalator
  name: 'dsh-v41-pro/escalator'
  config:
    mode: escalate
    proModel: <当前 provider 已注册、已授权的模型 ID>
    proReasoningEffort: high
```

关闭某个模块：

```yaml
- id: v41pro-forker
  disabled: true
```

插件沿用当前 provider，并通过 `llm.resolveModelInfo()` 探测目标模型与推理档位；不支持时退回提醒，不写死跨厂商档位。

## 验证

```bash
npm test                        # 21 个测试文件，189 个用例
npm run selfcheck               # 导出、locale、patch、图标资源检查
npm run reliability             # 6 个插件机制场景
powershell -File scripts/loop-runtime.ps1   # Windows：真实 DSH agent loop + fixture 模型
```

本仓库最近一次验证结果：

| 检查 | 结果 |
|---|---|
| `node --test test/*.test.mjs` | 189 通过 / 0 失败（530 ms） |
| `node scripts/selfcheck.mjs` | 18 个导出、18 个 patch 行 |
| `scripts/loop-runtime.ps1` | PASS：验收闸门、精简闸门、预测结算、规则注入 |
| 运行实例真实调用 `reasoning_max` | 4×4 网格最短路径 70，`stop=fast_path calls=2`；强制 low 时 1 候选 + 1 评审 + 1 综合 |

这些检查证明的是插件机制，不是模型综合能力。`scripts/loop-runtime.ps1` 用真实 DSH 0.2.2-rc.5 agent loop，但模型是固定 fixture，不调用收费模型。若要比较两个模型或插件版本，必须固定任务集、provider、系统提示、工具权限、预算、重试与评审标准，分别报告自主成功、人工协助、失败、超时与无效运行。

## 评测与对照

仓库另存了两次工程评测的可复核汇总与评分图。各只有一道题、每个对象一份提交，不能当作模型或插件的排行榜；评分者、方法与边界写在每页顶部。

| 评测 | 对象与结果 |
|---|---|
| [顶级难度 BUG 修复](evaluation/bugfix-2026-11-14.zh.md) · [EN](evaluation/bugfix-2026-11-14.en.md) | GPT-6 Astra 95.5 · Flash＋插件 92.5 · Flash 无插件 91.5（Claude Opus 5.5 / Kimi K3.1 Pro 评审）；另含 2026-11-21 dsv41 新插件版补充评审 96.5 |
| [AegisQueue](evaluation/aegisqueue-2026-11-22.zh.md) · [EN](evaluation/aegisqueue-2026-11-22.en.md) | 官方冻结分：dsv4.1、插件版、gpt6 Astra 均 100.000，glm5.3flash 96.952；另附事后严格复评 |

- 索引与共同边界：[evaluation/README.md](evaluation/README.md)
- 机器可读结果：[evaluation/data/results.json](evaluation/data/results.json)
- 评审图：[顶级难度 BUG 修复 · 四份答卷 12 维画像](evaluation/assets/bugfix-review-2026-11-21.jpg)

## 工程结构

```text
index.js              插件入口，装配 17 个 Host 模块
client.js             Client：思考模式菜单 + 全模态设置页
src/                  Host 模块
  core/               持久化、状态、消息、文本、证据与能力探测
  reasoning-max.js    Reasoning Max 3.0 引擎（thinking 私有库）
cordis.patch.yml      18 行 bundle patch
skills/               随包 Skill 正文
locale/               UI 文案（中 / 英）
omni/                 全模态媒体工具（源自 dsh-omni，MIT，含删减）
test/                 21 个 node:test 文件
scripts/              selfcheck、真实 loop、思考链、伦理准则与可靠性脚本
docs/                 设计说明与团队契约
evaluation/           两次工程评测、写作对照、评分图与机器可读结果
```

## 设计边界

- 插件不能增加模型参数、上下文窗口、视觉能力或训练知识。
- 未对未发布的 DeepSeek V4.1 Pro 做同条件对照，不能宣称全面超越。
- 台账是插件私有派生缓存，不替代 DSH 会话日志、Git 或工作区备份。
- 没有 `subagents` 服务时 `forker` / `critic` 休眠；没有 `shell` 服务时 `verifier` 不激活。
- 测试摘要识别覆盖 Node、pytest、Jest/Vitest、TAP、Go 的常见格式；其他框架可用退出码，或扩展识别器并补真实样例。
- 旧文档中未经验证的提升百分比已移除；精确技术契约见 [`docs/design.zh.md`](docs/design.zh.md)。

## 版本

- **1.11.0** — Reasoning Max 3.0：分层算力、并行候选、MCTS、PRM、多模型路由与 RL 日志。
- **1.10.0** — 工程闭环四件套：验收、校准、复盘、精简。
- **1.9.2** — 透彻模式：严格 `max`，追问根因与反例。
- **1.9.1** — 常驻 `ethical-conduct` 行为准则。
- **1.9.0** — 全模态媒体整合。

## License

MIT。见 [LICENSE](LICENSE)。`omni/` 目录保留上游 MIT 许可，见 [omni/LICENSE](omni/LICENSE)。
