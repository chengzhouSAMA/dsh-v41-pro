// 软门控升级：steer → 强 steer（要求实际工具调用）→ 在最终回答里强制标注"未验证"。
const GENERIC = /^(keep|kept|fine|ok|okay|n\/a|none|no change|looks good|lgtm|保留|没问题|无|不需要|不用|同上)/i;

// 汉字信息密度高，按 2 计权后再比较长度
const weight = (s) => { const c = (s.match(/[\u3400-\u9fff]/g) ?? []).length; return c * 2 + (s.length - c); };

export function isPerfunctory(reason) {
  const r = String(reason ?? '').trim();
  const w = weight(r);
  return w < 20 || (GENERIC.test(r) && w < 40);
}

// decisions: [{ file, action, reason }]
export function auditShrinkDecisions(decisions) {
  const perfunctory = decisions.filter((d) => isPerfunctory(d.reason)).map((d) => d.file);
  const seen = new Map();
  for (const d of decisions) {
    const k = String(d.reason ?? '').trim().toLowerCase();
    if (k) seen.set(k, [...(seen.get(k) ?? []), d.file]);
  }
  const duplicates = [...seen.values()].filter((fs) => fs.length >= 2).flat();
  return { perfunctory, duplicates, ok: !perfunctory.length && !duplicates.length };
}

export class GateTracker {
  constructor({ maxSteers = 2 } = {}) { this.maxSteers = maxSteers; this.gates = new Map(); this.history = []; }
  // 每个回合结束调用。pending: 未完成项；progress: 自上次 steer 以来是否有实际进展
  next(gate, { pending = [], progress = false } = {}) {
    const s = this.gates.get(gate) ?? { steers: 0 };
    if (!pending.length) { this.gates.delete(gate); return { action: 'pass' }; }
    if (s.steers >= 1 && progress) s.steers = Math.max(0, s.steers - 1); // 有进展则不惩罚
    if (s.steers === 0) { s.steers = 1; this.gates.set(gate, s); return { action: 'steer', message: `${gate}: 仍有未完成项：${pending.join('；')}` }; }
    if (s.steers < this.maxSteers) {
      s.steers += 1; this.gates.set(gate, s);
      return { action: 'steer-strong', message: `${gate}: 上次提醒后仍无进展。必须用工具调用逐项处理（运行命令或读写文件），只用文字回答不算完成：${pending.join('；')}` };
    }
    this.history.push({ gate, pending: [...pending] });
    this.gates.delete(gate);
    return { action: 'report-unverified', banner: banner(gate, pending) };
  }
  summary() {
    const m = new Map();
    for (const h of this.history) m.set(h.gate, (m.get(h.gate) ?? 0) + 1);
    return [...m].map(([gate, dismissed]) => ({ gate, dismissed }));
  }
}

export const banner = (gate, items) =>
  `⚠ 未验证：${gate} 仍有 ${items.length} 项未完成（${items.join('；')}）。以下结论不能视为已验证。`;
