/** 模型能力适配：只根据当前 provider 返回的元数据，不凭模型名称猜参数。 */

const EFFORT_ALIASES = Object.freeze({
  off: ['off'],
  low: ['low'],
  medium: ['medium', 'high'],
  high: ['high', 'medium', 'xhigh'],
  max: ['max', 'xhigh', 'high'],
  xhigh: ['xhigh', 'max', 'high'],
})

/**
 * 优先保留目标档位；不支持时只从该 provider 实际声明的档位中降级。
 * 没有元数据时返回 undefined，让 provider 使用自己的默认值。
 */
export function adaptReasoning(info, desired) {
  const efforts = Array.isArray(info?.reasoning?.efforts)
    ? info.reasoning.efforts.map(entry => entry?.id).filter(id => typeof id === 'string')
    : []
  if (!efforts.length || typeof desired !== 'string' || !desired) return undefined
  for (const candidate of [...(EFFORT_ALIASES[desired] ?? []), desired]) {
    if (efforts.includes(candidate)) return candidate
  }
  const fallback = info?.reasoning?.defaultEffort
  return typeof fallback === 'string' && efforts.includes(fallback) ? fallback : efforts[0]
}

/** 面向提示与诊断的元数据摘要；输出共享预算必须由实际 provider 明确声明。 */
export function capabilitySummary(info) {
  return {
    contextWindow: typeof info?.context?.contextWindow === 'number' ? info.context.contextWindow : null,
    defaultMaxTokens: typeof info?.defaultMaxTokens === 'number' ? info.defaultMaxTokens : null,
    outputBudgetShared: info?.outputBudgetShared === true,
    note: '插件不能增加模型上下文、输出预算、模态或参数；只适配当前 provider 声明的能力。',
  }
}
