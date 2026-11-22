import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReward, rankCandidates, canClaimVerified, SOFT_CEILING } from '../src/core/reward.js';

test('硬证据通过 + 评审低分，仍高奖励', () => {
  const r = computeReward({ verifier: { status: 'pass' }, judge: { score: 0.2 } });
  assert.equal(r.evidence, 'hard'); assert.ok(r.reward > 0.85);
});
test('硬证据失败 + 评审满分，奖励很低', () => {
  const r = computeReward({ verifier: { status: 'fail' }, judge: { score: 1 } });
  assert.ok(r.reward <= 0.151);
});
test('无硬证据时奖励不超过上限', () => {
  const r = computeReward({ judge: { score: 1, std: 0 } });
  assert.equal(r.evidence, 'soft'); assert.ok(r.reward <= SOFT_CEILING);
});
test('超时/零测试不更新路由', () => {
  for (const status of ['timeout', 'zero_tests', 'error']) {
    const r = computeReward({ verifier: { status }, judge: { score: 1 } });
    assert.equal(r.update, false);
  }
});
test('评审分歧大会降低软奖励', () => {
  const a = computeReward({ judge: { score: 0.8, std: 0 } }).reward;
  const b = computeReward({ judge: { score: 0.8, std: 0.4 } }).reward;
  assert.ok(b < a);
});
test('排序：验证通过 > 高评审分 > 验证失败', () => {
  const [first, second, third] = rankCandidates([
    { id: 'fail', verifier: { status: 'fail' }, judge: { score: 1 } },
    { id: 'soft', judge: { score: 0.9 } },
    { id: 'pass', verifier: { status: 'pass' }, judge: { score: 0.3 } },
  ]);
  assert.deepEqual([first.id, second.id, third.id], ['pass', 'soft', 'fail']);
});
test('只有硬证据通过才能声称已验证', () => {
  assert.equal(canClaimVerified({ verifier: { status: 'pass' } }), true);
  assert.equal(canClaimVerified({ judge: { score: 1 } }), false);
});
