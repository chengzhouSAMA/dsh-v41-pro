/**
 * 模型可见文案。
 *
 * 三条写作原则（都是从 Flash 的失败模式倒推的）：
 *  1. 说清「哪条证据」触发了干预 —— 泛泛的「请仔细一点」对 Flash 无效。
 *  2. 给出**有限的**下一步选项 —— 开放式建议会让小模型继续原地打转。
 *  3. 明确声明这不是用户说的话 —— 否则模型会把它当成新需求去做。
 */

const SOURCE_NOTE_ZH = '（这是 harness 自动注入的系统提示，不是用户的新消息。）'
const SOURCE_NOTE_EN = '(This is an automatic harness note, not a new message from the user.)'

/** @param {string} language */
export function sourceNote(language) {
  return language === 'en' ? SOURCE_NOTE_EN : SOURCE_NOTE_ZH
}

/**
 * 把探测到的信号渲染成一行行可读证据。
 * @param {Array<{ kind: string, detail: string }>} signals
 */
export function signalLines(signals) {
  const labels = {
    repeat: '重复调用',
    failure: '连续失败',
    repeatedFailure: '重复失败',
    edit: '同一文件反复修改',
    drift: '长时间没有进展',
    doubt: '模型自述不确定',
  }
  return signals.map(signal => `- ${labels[signal.kind] ?? signal.kind}：${signal.detail}`)
}

/**
 * 第一次干预：轻提醒。只要求它重新读一遍证据。
 * @param {{ language: string, lines: string[] }} input
 */
export function gentleReminder({ language, lines }) {
  const head = language === 'en'
    ? 'You appear to be stuck. Evidence:'
    : '你可能已经卡住了。证据：'
  const tail = language === 'en'
    ? 'Before your next call: re-read the latest tool result, state in one sentence what you now know, then either change approach or finish. Do not repeat the action above.'
    : '下一次调用之前：重读最近一次工具结果，用一句话说出你现在确定知道什么，然后要么换一种做法，要么直接结束。不要重复上面的动作。'
  return [head, ...lines, '', tail, '', sourceNote(language)].join('\n')
}

/**
 * 第二次干预（未升级模型时）：强提醒，给出有限选项。
 * @param {{ language: string, lines: string[], tool: string }} input
 */
export function strongReminder({ language, lines, tool }) {
  const head = language === 'en'
    ? 'Still stuck after a reminder. Evidence:'
    : '提醒之后仍然卡住。证据：'
  const options = language === 'en'
    ? [
        'Choose exactly one of these and do it now:',
        `1. Establish a fact you are missing, with a different tool than \`${tool}\`.`,
        '2. Write down the hypothesis you are assuming, then test it directly.',
        '3. Stop and report the blocker to the user, with what you tried and what you need.',
      ]
    : [
        '现在只能选一个，立刻做：',
        `1. 用**不同于** \`${tool}\` 的工具去确认一个你还不知道的事实。`,
        '2. 把你正在假设的前提写出来，然后用最小代价直接验证它。',
        '3. 停下来向用户报告阻塞：你试了什么、还缺什么。',
      ]
  return [head, ...lines, '', ...options, '', sourceNote(language)].join('\n')
}

/**
 * 已升级到更强模型。
 * @param {{ language: string, model: string, steps: number, lines: string[] }} input
 */
export function escalatedNotice({ language, model, steps, lines }) {
  const head = language === 'en'
    ? `This step has been escalated to \`${model}\` for the next ${steps} steps because:`
    : `因为下面的原因，接下来的 ${steps} 步已升级到 \`${model}\`：`
  const tail = language === 'en'
    ? 'Use the extra capacity on the blocked decision only: find the missing fact, or commit to one approach. Do not re-plan from scratch.'
    : '把多出来的能力只花在那个卡住的判断上：补齐缺失的事实，或者在几个方向里选定一个。不要从头重做计划。'
  return [head, ...lines, '', tail, '', sourceNote(language)].join('\n')
}

/**
 * 预算用尽 / 需要人接手。
 * @param {{ language: string, reason: string }} input
 */
export function handoffNotice({ language, reason }) {
  return language === 'en'
    ? `Hand this back to the user now.\nReason: ${reason}\nDo not attempt another fix. Summarize: what you changed, what is verified, what is blocking, and the single question the user must answer.\n\n${sourceNote(language)}`
    : `现在把这件事交回给用户。\n原因：${reason}\n不要再尝试新的修复。请总结：改了什么、什么已经验证过、卡在哪里、需要用户回答的那一个问题。\n\n${sourceNote(language)}`
}

/**
 * 本轮步数超预算。
 * @param {{ language: string, steps: number, limit: number }} input
 */
export function budgetNotice({ language, steps, limit }) {
  return language === 'en'
    ? `This turn has run ${steps} steps (budget ${limit}). Stop expanding scope: finish the current smallest unit of work, verify it, and report. ${sourceNote(language)}`
    : `本轮已经跑了 ${steps} 步（预算 ${limit}）。停止扩大范围：把当前最小的那个单元做完、验证、汇报。\n\n${sourceNote(language)}`
}

/**
 * 本轮 wall clock（挂钟时间）超预算。
 * @param {{ language: string, minutes: number, limit: number }} input
 */
export function timeBudgetNotice({ language, minutes, limit }) {
  return language === 'en'
    ? `This turn has been running for ${minutes} minutes (budget ${limit}). Wrap up: state what is done, what is verified, and what remains. ${sourceNote(language)}`
    : `本轮已经跑了 ${minutes} 分钟（预算 ${limit}）。收尾：说清做完了什么、验证了什么、还剩什么。\n\n${sourceNote(language)}`
}

/**
 * 同一个工具反复失败。
 * @param {{ language: string, tool: string, failures: number }} input
 */
export function toolFailureNotice({ language, tool, failures }) {
  return language === 'en'
    ? `\`${tool}\` has failed ${failures} times this turn. Stop retrying it with the same shape: either change the input materially, switch to a different tool, or report the blocker. ${sourceNote(language)}`
    : `\`${tool}\` 在本轮已经失败了 ${failures} 次。不要再用同样的形状重试：要么实质性地换输入，要么换一个工具，要么直接报告阻塞。\n\n${sourceNote(language)}`
}

/**
 * forker 的候选方案汇编。
 * @param {{ language: string, question: string, candidates: Array<{lens: string, proposal: string, firstStep: string, risk: string}> }} input
 */
export function forkDigest({ language, question, candidates }) {
  const zh = language !== 'en'
  const lines = [zh ? `## 决策候选：${question}` : `## Candidates for: ${question}`, '']
  candidates.forEach((candidate, index) => {
    lines.push(zh ? `### ${index + 1}. ${candidate.lens}` : `### ${index + 1}. ${candidate.lens}`)
    lines.push(candidate.proposal)
    lines.push(zh ? `- 第一步：${candidate.firstStep}` : `- First step: ${candidate.firstStep}`)
    lines.push(zh ? `- 主要风险：${candidate.risk}` : `- Main risk: ${candidate.risk}`)
    lines.push('')
  })
  lines.push(zh
    ? '选一个，然后只做那个。不要试图把多个候选拼起来——那通常是三个方案里最差的部分的组合。'
    : 'Pick exactly one and do only that. Do not merge candidates — merges usually take the worst part of each.')
  return lines.join('\n')
}

/**
 * critic 的复审报告外壳。
 * @param {{ language: string, verdict: string, report: string }} input
 */
export function critiqueDigest({ language, verdict, report }) {
  const zh = language !== 'en'
  const head = verdict === 'ok'
    ? (zh ? '## 复审结论：未发现阻塞性问题' : '## Review: no blocking issue found')
    : (zh ? '## 复审结论：存在问题' : '## Review: issues found')
  const tail = zh
    ? '\n\n处理规则：只修「阻塞」和「严重」两级；「建议」级可以先跳过并说明理由。'
    : '\n\nHandling: fix blocking and severe items; you may skip suggestions with a stated reason.'
  return [head, '', report, tail].join('\n')
}

/**
 * 上下文地图（压缩后重建）。
 * @param {{
 *   language: string,
 *   step: number,
 *   compactions: number,
 *   goal: string,
 *   edited: string[],
 *   read: string[],
 *   verification?: { command: string, ok: boolean, detail: string } | null,
 *   verificationFailure?: { command: string, ok: boolean, detail: string } | null,
 * }} input
 */
export function contextMap({ language, step, compactions, goal, edited, read, verification, verificationFailure }) {
  const zh = language !== 'en'
  const lines = []
  lines.push(zh
    ? `## 上下文地图（第 ${step} 步${compactions > 0 ? `，已压缩 ${compactions} 次` : ''}）`
    : `## Context map (step ${step}${compactions > 0 ? `, compacted ${compactions}×` : ''})`)
  if (goal) lines.push('', zh ? `**本轮目标**：${goal}` : `**Turn goal**: ${goal}`)
  if (edited.length > 0) {
    lines.push('', zh ? '**改过的文件（细节可能已被压缩掉）**：' : '**Edited (details may have been compacted away)**:')
    for (const file of edited) lines.push(`- \`${file}\``)
  }
  if (read.length > 0) {
    lines.push('', zh ? '**读过的文件**：' : '**Read**:')
    for (const file of read) lines.push(`- \`${file}\``)
  }
  if (verification?.ok) {
    lines.push('', zh ? `**最近验证**：\`${verification.command}\` 已通过；不代表其他检查也通过。` : `**Latest verification**: \`${verification.command}\` passed; other checks may remain unresolved.`)
  }
  const failure = verificationFailure ?? (verification?.ok ? null : verification)
  if (failure) {
    lines.push('', zh ? '**验证证据（不是成功）**：' : '**Verification evidence (not a success)**:')
    lines.push(zh
      ? `- \`${failure.command}\` 尚未通过验证；最近结果：${failure.detail}`
      : `- \`${failure.command}\` has not passed; latest result: ${failure.detail}`)
  }
  lines.push('', zh
    ? '需要某个文件的具体内容时，重新用工具读一次。**不要凭印象复述已经不在上下文里的代码。**'
    : 'Re-read a file when you need its exact contents. **Do not paraphrase code that is no longer in context.**')
  lines.push('', sourceNote(language))
  return lines.join('\n')
}

/**
 * 台账现状卡。
 * @param {{
 *   language: string,
 *   goal: string,
 *   files: Array<{ path: string, count: number }>,
 *   failures: Array<{ tool: string, message: string }>,
 *   commands: Array<{ command: string, ok: boolean }>,
 *   step: number,
 * }} input
 */
export function ledgerCard({ language, goal, files, failures, commands, step }) {
  const zh = language !== 'en'
  const lines = []
  lines.push(zh ? `## 现状卡（第 ${step} 步，自动注入）` : `## Situation card (step ${step}, injected automatically)`)
  if (goal) lines.push('', zh ? `**本轮目标**：${goal}` : `**Turn goal**: ${goal}`)

  if (files.length > 0) {
    lines.push('', zh ? '**已改动**：' : '**Changed**:')
    for (const file of files) {
      lines.push(`- \`${file.path}\`${file.count > 1 ? (zh ? `（改了 ${file.count} 次）` : ` (edited ${file.count}×)`) : ''}`)
    }
  }

  if (failures.length > 0) {
    lines.push('', zh ? '**失败过（不要原样重试）**：' : '**Already failed (do not retry verbatim)**:')
    for (const failure of failures) {
      lines.push(`- \`${failure.tool}\`: ${failure.message}`)
    }
  }

  if (commands.length > 0) {
    lines.push('', zh ? '**最近命令**：' : '**Recent commands**:')
    for (const command of commands) {
      lines.push(`- ${command.ok ? '✓' : '✗'} \`${command.command}\``)
    }
  }

  if (lines.length === 3) {
    lines.push('', zh ? '（还没有可记录的事实。）' : '(No recorded facts yet.)')
  }
  lines.push('', sourceNote(language))
  return lines.join('\n')
}

/**
 * 验证闸门：改了东西但没验证。
 * @param {{ language: string, files: string[], commands: Array<{ name: string, command: string }>, lastVerify: string }} input
 */
export function verifyNudge({ language, files, commands, lastVerify }) {
  const zh = language !== 'en'
  const list = files.slice(0, 5).map(file => `\`${file}\``).join('、')
  const head = zh
    ? `这一轮你改动了 ${files.length} 个文件（${list}${files.length > 5 ? ' 等' : ''}），但之后没有一次成功的验证。`
    : `You changed ${files.length} file(s) (${list}${files.length > 5 ? ', …' : ''}) and have not verified since.`
  const options = commands.length > 0
    ? (zh
        ? ['', '运行其中一条并贴出结果，再决定是否结束：', ...commands.map(command => `- \`${command.name}\`：\`${command.command}\``)]
        : ['', 'Run one of these and show the result before finishing:', ...commands.map(command => `- \`${command.name}\`: \`${command.command}\``)])
    : (zh
        ? ['', '没有配置验证命令。请直接用现有工具跑一次最小检查（编译、测试、或复现你声称修好的那个问题），把结果贴出来。']
        : ['', 'No verify command is configured. Use an existing tool to run the smallest possible check and paste the result.'])
  const last = lastVerify
    ? (zh ? ['', `上一次成功验证：${lastVerify}`] : ['', `Last successful verification: ${lastVerify}`])
    : []
  return [head, ...last, ...options, '', sourceNote(language)].join('\n')
}
