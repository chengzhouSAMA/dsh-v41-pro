// 奖励信号：可验证证据优先，LLM 评审只作辅助，且无硬证据时有上限。
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const SOFT_CEILING = 0.7;
const INVALID = new Set(['timeout', 'zero_tests', 'error']);

// verifier: { status: 'pass'|'fail'|'timeout'|'zero_tests'|'error'|'none' }
// judge:    { score: 0..1, std?: 0..0.5 }
export function computeReward({ verifier, judge, hardWeight = 0.85 } = {}) {
  if (verifier && INVALID.has(verifier.status)) return { reward: 0, evidence: 'invalid', update: false };
  const hard = verifier?.status === 'pass' ? 1 : verifier?.status === 'fail' ? 0 : null;
  const j = judge && Number.isFinite(judge.score) ? clamp(judge.score) : null;
  const soft = j === null ? null : j * (1 - clamp(judge.std ?? 0, 0, 0.5));
  if (hard !== null) {
    const reward = soft === null ? hard : hardWeight * hard + (1 - hardWeight) * soft;
    return { reward, evidence: 'hard', update: true };
  }
  if (soft !== null) return { reward: Math.min(soft, SOFT_CEILING), evidence: 'soft', update: true };
  return { reward: 0, evidence: 'none', update: false };
}

// 候选排序：硬证据通过 > 软评分 > 硬证据失败；同级按奖励
export function rankCandidates(cands) {
  const tier = (e, r) => (e === 'hard' ? (r >= 0.5 ? 3 : 0) : e === 'soft' ? 2 : 1);
  return cands
    .map((c) => ({ ...c, ...computeReward(c) }))
    .sort((a, b) => tier(b.evidence, b.reward) - tier(a.evidence, a.reward) || b.reward - a.reward);
}

// 只有"硬证据通过"才允许对用户声称"已验证"
export const canClaimVerified = (c) => computeReward(c).evidence === 'hard' && c.verifier?.status === 'pass';
