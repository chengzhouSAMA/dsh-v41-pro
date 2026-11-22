/**
 * v41pro-critic —— 独立视角复审。
 *
 * 让模型「自我检查」是无效的：它会在自己那条上下文里对自己的推理合理化，一路
 * 顺下去。真正有效的做法是换一个人看——一个**没有参与过这份工作**的子代理，
 * 只拿到「用户要什么」和「产物是什么」，不给推理过程。
 *
 * 注册 `pro_critique` 工具，spawn 一个全新上下文的子代理做对抗性复审。
 * 子代理只读：它的任务是挑错，不是修。
 *
 * 契约基线：deepseek-harness 0.2.2-rc.3。子代理用
 * `ctx.subagents.startActivation({ provider, label, prompt, parent, signal,
 * delivery: 'caller', agentOptions? })` 启动；旧的
 * `ctx.subagents.start(name, request)` 与 `request.toolFilter` 都已不存在。
 *
 * 判定原则（fail-closed）：只有子代理**明确**说通过才算通过；解析不出来、超时、
 * 失败，一律按「有问题」处理或直接报错，绝不默认放行。
 */

import { bool, makeLogger, num, str, strList } from './core/config.js'
import { blocksToText, truncate } from './core/util.js'
import { critiqueDigest } from './core/text.js'

export const name = 'v41pro-critic'

export const inject = ['tools', 'subagents']

export const DEFAULTS = {
  enabled: true,
  provider: 'spawn',
  timeoutMs: 240_000,
  childModel: '',
  childToolFilter: null,
  language: 'zh',
  /** 报告最多保留多少字符。 */
  reportChars: 6000,
}

function criticPrompt({ spec, summary, files, focus, language }) {
  const zh = language !== 'en'
  if (!zh) {
    return [
      'You are an independent reviewer. You did not do this work and you should not trust the author\'s conclusion.',
      'Read-only: do not modify anything.',
      '',
      spec ? `What the user asked for:\n${spec}` : '(The original request is not provided; judge only internal consistency.)',
      `What the author claims was done:\n${summary}`,
      files.length ? `Files involved:\n${files.map(file => `- ${file}`).join('\n')}` : '(No files named.)',
      focus ? `Pay special attention to: ${focus}` : '',
      '',
      'Check, in this order:',
      '1. Any part of the request that is not actually satisfied.',
      '2. Anything broken outside the touched area.',
      '3. Anything that looks right but was never verified.',
      '4. A materially simpler approach that was ignored.',
      '',
      'Answer exactly in this shape:',
      'VERDICT: PASS or VERDICT: ISSUES',
      'ISSUES:',
      '1. [blocking|severe|suggestion] file — problem — suggested fix',
      '(write "none" when there is nothing)',
    ].filter(Boolean).join('\n')
  }
  return [
    '你是一名独立复审者。你没有参与这份工作，也不应该相信作者的结论。',
    '只读：不要修改任何文件。',
    '',
    spec ? `用户的要求：\n${spec}` : '（没有提供原始需求，只判断内部一致性。）',
    `作者声称完成的：\n${summary}`,
    files.length ? `涉及的文件：\n${files.map(file => `- ${file}`).join('\n')}` : '（没有指定文件。）',
    focus ? `特别关注：${focus}` : '',
    '',
    '按顺序检查：',
    '1. 要求里有没有**实际没被满足**的部分（不要相信语气，去读代码/产物）。',
    '2. 改动边界之外有没有被破坏。',
    '3. 有没有「看起来对但从未验证」的地方。',
    '4. 有没有被忽略的、明显更简单的做法。',
    '',
    '严格按这个形状输出：',
    '结论：通过 或 结论：有问题',
    '问题：',
    '1. [阻塞|严重|建议] 文件 — 问题 — 建议改法',
    '（没有问题就写「无」）',
  ].filter(Boolean).join('\n')
}

/** 从子代理输出里解析结论。fail-closed：没明确说通过就是有问题。 */
export function parseVerdict(text) {
  const value = String(text ?? '')
  if (/结论\s*[：:]\s*通过/.test(value)) return 'ok'
  if (/VERDICT\s*:\s*PASS/i.test(value)) return 'ok'
  return 'issues'
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx, name)
  const cfg = normalize(rawConfig, logger)
  if (!cfg.enabled) {
    logger.info('enabled=false，独立复审已关闭')
    return
  }

  /** 子代理模型只在 provider 支持 agentOptions 时才传。 */
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

  async function runCritic(agent, promptText, signal) {
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
        label: 'pro_critique',
        prompt: [{ type: 'text', text: promptText }],
        parent: agent,
        signal: controller.signal,
        // 结论由本工具解析后交回主模型，不往父代理回合里再塞一条通知。
        delivery: 'caller',
        ...(childModel() ? { agentOptions: { model: childModel() } } : {}),
      })
      const result = await activation.result
      if (timedOut) return { ok: false, reason: 'timeout', text: '' }
      if (result?.stopReason !== 'completed') {
        return { ok: false, reason: String(result?.stopReason ?? 'unknown'), text: blocksToText(result?.output ?? []) }
      }
      return { ok: true, reason: 'completed', text: blocksToText(result?.output ?? []) }
    } catch (error) {
      return { ok: false, reason: timedOut ? 'timeout' : (error instanceof Error ? error.message : String(error)), text: '' }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
      if (activation) {
        try {
          await activation.dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }

  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'pro_critique',
      description: [
        '请一个没有参与这份工作的独立代理做对抗性复审，只读、只挑错。',
        '什么时候用：在宣称任务完成之前，尤其是改动跨多个文件、或者你只验证了「它能跑」而没验证「它满足需求」时。',
        '怎么写 summary：写清「用户要什么」和「你实际做了什么」，不要写你的推理过程——理由留给自己，证据留给复审者。',
        '结论是 fail-closed 的：只有复审者明确说通过才算通过。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: '你实际做了什么：改了哪些行为、为什么这么改。不要复述思考过程。',
          },
          spec: {
            type: 'string',
            description: '用户的原始要求（尽量原文）。没有它可以省略，但复审质量会下降。',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '涉及的文件路径；复审者会自己去读。',
          },
          focus: {
            type: 'string',
            description: '你特别担心的地方，让复审者优先看。',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            verdict: { type: 'string' },
            report: { type: 'string' },
          },
          required: ['verdict', 'report'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{
            type: 'text',
            text: critiqueDigest({ language: cfg.language, verdict: value.verdict, report: value.report }),
          }]
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
        if (!summary) throw new Error('pro_critique 需要 summary：说清你实际做了什么。')

        const spec = typeof input.spec === 'string' ? input.spec.trim() : ''
        const files = strList(input.files, [])
        const focus = typeof input.focus === 'string' ? input.focus.trim() : ''
        const agent = exec?.agent
        if (!agent) throw new Error('pro_critique 只能在 agent 会话里调用。')
        assertProvider(ctx, cfg.provider)

        const outcome = await runCritic(
          agent,
          criticPrompt({ spec, summary, files, focus, language: cfg.language }),
          exec?.signal,
        )

        if (!outcome.ok) {
          // 复审没跑成 ≠ 复审通过，也 ≠ 复审发现问题。如实报错，别伪造结论。
          throw new Error(`独立复审未能完成（${outcome.reason}），这不代表没有问题——请重试或自行检查。`)
        }

        const verdict = parseVerdict(outcome.text)
        logger.info(`pro_critique：${verdict}`)
        return { verdict, report: truncate(outcome.text.trim(), cfg.reportChars) }
      },
    })

    return () => {
      try {
        disposer?.()
      } catch {
        /* ignore */
      }
    }
  }, 'v41pro-critic tool')
}

function normalize(raw, logger) {
  const config = raw && typeof raw === 'object' ? raw : {}
  if (config.childToolFilter !== undefined && config.childToolFilter !== null) {
    logger.warn('0.2.2-rc.3 的 subagent startActivation 不再支持 toolFilter，childToolFilter 已忽略')
  }
  return {
    enabled: bool(config.enabled, DEFAULTS.enabled),
    provider: str(config.provider, DEFAULTS.provider),
    timeoutMs: num(config.timeoutMs, DEFAULTS.timeoutMs, { min: 10_000, max: 1_800_000 }),
    childModel: str(config.childModel, DEFAULTS.childModel),
    language: str(config.language, DEFAULTS.language) === 'en' ? 'en' : 'zh',
    reportChars: num(config.reportChars, DEFAULTS.reportChars, { min: 500 }),
  }
}

/** provider 不存在时提前给出可读的错误。 */
function assertProvider(ctx, name) {
  if (typeof ctx.subagents?.getProvider !== 'function') return
  if (ctx.subagents.getProvider(name) === undefined) {
    throw new Error(`找不到 subagent provider "${name}"：请确认 profile 里挂了 subagent-spawn-in-process（默认注册名 spawn）。`)
  }
}
