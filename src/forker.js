/**
 * v41pro-forker —— 决策点分叉。
 *
 * 小模型最贵的失败不是「选错」，是**只想到一个方案**。Pro 在同样的位置会自然
 * 地权衡三条路，Flash 往往抓住第一条就开跑。
 *
 * 这个插件不替模型选，它负责把「从零生成一个好方案」这个判断，变成「在三个
 * 具体方案里挑一个」这个选择题 —— 后者对 Flash 容易得多。
 *
 * 实现：注册 `pro_fork` 工具，并行 spawn N 个**全新上下文**的子代理，每个用
 * 不同视角各提一个方案（只提案，不执行），汇编后交回主模型。
 *
 * 关键取舍：
 *  - 用 `spawn` 而不是 `fork`：要的是互相看不见的独立视角，不是继承同一份偏见。
 *  - 子代理**不传 outputSchema**：不同 provider 的能力标记不一致，传了会在 start
 *    阶段被拒；改成约定文本格式 + 宽松解析，任何 provider 都能跑。
 *  - 子代理**不做工具限制**：0.2.2-rc.3 的 `startActivation` 已经没有
 *    `toolFilter` 字段（它只存在于 fork 的历史种子描述里），硬传会被忽略。
 *  - 每次 start 都必须 `await activation.dispose()`，否则子会话资源不释放。
 *
 * 契约基线：deepseek-harness 0.2.2-rc.3。
 *   ctx.subagents.startActivation({
 *     provider, label, prompt, parent, signal, delivery,
 *     agentOptions?, outputSchema?, maxDepth?, cwd?, name?, agentPreset?,
 *   }) → { childId, name, messageId?, result, dispose }
 *
 * 和 0.1.x 的差别：老的 `ctx.subagents.start(name, request)` 没有了；
 * `delivery: 'caller'` 表示结果只回到本次调用（父代理不会再收到一条通知），
 * 正是分叉需要的语义——候选由本工具自己汇编后再交给主模型。
 */

import { bool, makeLogger, num, str, strList } from './core/config.js'
import { blocksToText, truncate } from './core/util.js'
import { forkDigest } from './core/text.js'

export const name = 'v41pro-forker'

export const inject = ['tools', 'subagents']

export const DEFAULTS = {
  enabled: true,
  /** 使用哪个 subagent provider。基座默认注册了 'spawn' 与 'fork'。 */
  provider: 'spawn',
  /** 默认候选数量。 */
  count: 3,
  /** 候选数量上限（工具参数最多能要几个）。 */
  maxCount: 4,
  /** 每个子代理的超时（毫秒）。 */
  timeoutMs: 180_000,
  /** 子代理使用的模型；空字符串表示继承父代理。 */
  childModel: '',
  /** 子代理的工具限制（{allow?, deny?}）；null 表示不限制。 */
  childToolFilter: null,
  language: 'zh',
  /** 不指定 lenses 时使用的默认视角。 */
  defaultLenses: [
    '最小改动：用最少的新代码和最少的新概念解决问题',
    '风险优先：先消除最可能让这次改动失败的那个模式',
    '用户可见优先：先让外部可观察的行为正确，内部结构留到以后',
    '可回滚优先：选一个出错时最容易撤回的方向',
  ],
}

/** 每个视角的提案格式。解析是宽松的，认全角/半角冒号。 */
function childPrompt({ question, context, lens, language }) {
  const zh = language !== 'en'
  if (!zh) {
    return [
      'You are a proposal generator. Your only job is to propose ONE approach to the decision below.',
      'Do not implement anything. Do not modify files. Read what you need, then answer.',
      '',
      `Decision: ${question}`,
      context ? `Context: ${context}` : '',
      `Lens: ${lens}`,
      '',
      'Answer with exactly these three lines and nothing else:',
      'PROPOSAL: <at most 3 sentences>',
      'FIRST STEP: <one concrete action someone can take immediately>',
      'MAIN RISK: <one sentence>',
    ].filter(Boolean).join('\n')
  }
  return [
    '你是一个「方案候选生成器」。唯一任务是为下面的决策提出**一个**方案。',
    '不要实现，不要修改任何文件。需要的话先读代码，然后回答。',
    '',
    `决策：${question}`,
    context ? `背景：${context}` : '',
    `视角：${lens}`,
    '',
    '严格按下面三行输出，不要任何多余内容：',
    '方案：<不超过三句>',
    '第一步：<一个可以立刻执行的具体动作>',
    '主要风险：<一句话>',
  ].filter(Boolean).join('\n')
}

/** 宽松解析子代理的三行输出。 */
export function parseProposal(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const pick = (zhLabel, enLabel) => {
    for (const line of lines) {
      const trimmed = line.trim().replace(/^[-*\s]+/, '')
      for (const label of [zhLabel, enLabel]) {
        const withColon = new RegExp(`^${label}\\s*[：:]\\s*(.+)$`)
        const match = withColon.exec(trimmed)
        if (match) return match[1].trim()
      }
    }
    return ''
  }
  const proposal = pick('方案', 'PROPOSAL')
  const firstStep = pick('第一步', 'FIRST STEP')
  const risk = pick('主要风险', 'MAIN RISK')
  // 完全解析不出来时，把整段当方案——总比丢掉好。
  return {
    proposal: proposal || truncate(String(text ?? '').trim(), 600) || '(空)',
    firstStep: firstStep || '(未给出)',
    risk: risk || '(未给出)',
  }
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = normalize(rawConfig, logger)
  if (!cfg.enabled) {
    logger.info('enabled=false，决策点分叉已关闭')
    return
  }

  /** 子代理模型只在 provider 支持 agentOptions 时才传；不支持时退回继承父代理。 */
  let warnedChildModel = false
  function childModel() {
    if (!cfg.childModel) return ''
    const provider = typeof ctx.subagents?.getProvider === 'function'
      ? ctx.subagents.getProvider(cfg.provider)
      : undefined
    if (provider?.capabilities && provider.capabilities.agentOptions === false) {
      if (!warnedChildModel) {
        warnedChildModel = true
        logger.warn(`provider "${cfg.provider}" 不支持 child agentOptions，childModel 已忽略`)
      }
      return ''
    }
    return cfg.childModel
  }

  /**
   * 跑一个子代理并拿回纯文本。
   * @returns {Promise<{ ok: boolean, text: string, reason: string }>}
   */
  async function runChild(agent, promptText, label, signal) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, cfg.timeoutMs)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    let activation
    try {
      activation = await ctx.subagents.startActivation({
        provider: cfg.provider,
        label,
        prompt: [{ type: 'text', text: promptText }],
        parent: agent,
        signal: controller.signal,
        // 候选由本工具汇编后交给主模型，不需要再往父代理的回合里回一条通知。
        delivery: 'caller',
        ...(childModel() ? { agentOptions: { model: childModel() } } : {}),
      })
      const result = await activation.result
      return {
        ok: result?.stopReason === 'completed',
        text: blocksToText(result?.output ?? []),
        reason: timedOut ? 'timeout' : String(result?.stopReason ?? 'unknown'),
      }
    } catch (error) {
      return {
        ok: false,
        text: '',
        reason: timedOut ? 'timeout' : (error instanceof Error ? error.message : String(error)),
      }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
      if (activation) {
        try {
          await activation.dispose()
        } catch {
          /* dispose 失败不能影响主流程 */
        }
      }
    }
  }

  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'pro_fork',
      description: [
        '对一个决策并行生成多个独立方案候选（只提案，不执行），交回给你挑选。',
        '什么时候用：当你发现自己在几个方向之间拿不准，或者第一直觉可能不是最优、但你只有这一个想法时。',
        '什么时候不用：事实性问题、机械改动、已经明确该怎么做的事。这个工具很贵。',
        '拿到候选之后：选**一个**，然后只做那一个。不要试图把多个候选拼起来。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '要分叉的决策，一句话。例如「如何在不改公共 API 的前提下加上重试」。',
          },
          context: {
            type: 'string',
            description: '必要的背景：现状、已经试过什么、硬约束。会原样交给每个候选。',
          },
          lenses: {
            type: 'array',
            items: { type: 'string' },
            description: '想要的视角。留空使用默认的几种（最小改动 / 风险优先 / 用户可见优先）。',
          },
          count: {
            type: 'integer',
            description: '候选数量。默认取插件配置。',
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  lens: { type: 'string' },
                  proposal: { type: 'string' },
                  firstStep: { type: 'string' },
                  risk: { type: 'string' },
                },
                required: ['lens', 'proposal', 'firstStep', 'risk'],
                additionalProperties: false,
              },
            },
            failed: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  lens: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['lens', 'reason'],
                additionalProperties: false,
              },
            },
          },
          required: ['question', 'candidates', 'failed'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (!value.candidates.length) {
            return [{
              type: 'text',
              text: `所有候选都没跑成功：${value.failed.map(item => `${item.lens}=${item.reason}`).join('；')}`,
            }]
          }
          return [{
            type: 'text',
            text: forkDigest({
              language: cfg.language,
              question: value.question,
              candidates: value.candidates,
            }) + (value.failed.length
              ? `\n\n（${value.failed.length} 个候选失败：${value.failed.map(item => item.reason).join('；')}）`
              : ''),
          }]
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const question = typeof input.question === 'string' ? input.question.trim() : ''
        if (!question) throw new Error('pro_fork 需要 question：一句话说明要分叉的决策。')

        const context = typeof input.context === 'string' ? input.context.trim() : ''
        const lensList = strList(input.lenses, cfg.defaultLenses)
        const count = Math.min(
          num(input.count, cfg.count, { min: 1, max: cfg.maxCount }),
          lensList.length,
          cfg.maxCount,
        )

        const agent = exec?.agent
        if (!agent) throw new Error('pro_fork 只能在 agent 会话里调用。')
        assertProvider(ctx, cfg.provider)

        const selected = lensList.slice(0, count)
        const settled = await Promise.all(
          selected.map((lens, index) => runChild(
            agent,
            childPrompt({ question, context, lens, language: cfg.language }),
            `pro_fork:${index + 1}`,
            exec?.signal,
          )),
        )

        const candidates = []
        const failed = []
        settled.forEach((outcome, index) => {
          const lens = selected[index]
          if (!outcome.ok || !outcome.text.trim()) {
            failed.push({ lens, reason: outcome.reason })
            return
          }
          const parsed = parseProposal(outcome.text)
          candidates.push({ lens, ...parsed })
        })

        logger.info(`pro_fork：${candidates.length} 个候选成功，${failed.length} 个失败`)
        return { question, candidates, failed }
      },
    })

    return () => {
      try {
        disposer?.()
      } catch {
        /* ignore */
      }
    }
  }, 'v41pro-forker tool')
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  if (config.childToolFilter !== undefined && config.childToolFilter !== null) {
    logger.warn('0.2.2-rc.3 的 subagent startActivation 不再支持 toolFilter，childToolFilter 已忽略')
  }
  return {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    provider: str(config.provider, DEFAULTS.provider),
    count: num(config.count, DEFAULTS.count, { min: 1, max: 4 }),
    maxCount: num(config.maxCount, DEFAULTS.maxCount, { min: 1, max: 4 }),
    timeoutMs: num(config.timeoutMs, DEFAULTS.timeoutMs, { min: 10_000, max: 1_800_000 }),
    childModel: str(config.childModel, DEFAULTS.childModel),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    defaultLenses: strList(config.defaultLenses, DEFAULTS.defaultLenses),
  }
}

/** provider 不存在时提前给出可读的错误，而不是让启动阶段抛 provider 错误。 */
function assertProvider(ctx, name) {
  if (typeof ctx.subagents?.getProvider !== 'function') return
  if (ctx.subagents.getProvider(name) === undefined) {
    throw new Error(`找不到 subagent provider "${name}"：请确认 profile 里挂了 subagent-spawn-in-process（默认注册名 spawn）。`)
  }
}
