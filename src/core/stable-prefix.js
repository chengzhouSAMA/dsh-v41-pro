// 保证常驻提示（如 ethical-conduct）放在稳定前缀里，才能吃到提示缓存。
import { createHash } from 'node:crypto';

const VOLATILE = [
  ['日期/时间戳', /\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/],
  ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['毫秒时间戳', /\b1[5-9]\d{11}\b/],
  ['会话ID', /\bsession[-_ ]?id\b/i],
];

export function lintPrefix(text) {
  const out = [];
  for (const [rule, re] of VOLATILE) {
    const m = re.exec(text);
    if (m) out.push({ rule, sample: m[0], index: m.index });
  }
  return out;
}

export function approxTokens(s) {
  const cjk = (s.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 1 + (s.length - cjk) / 4);
}

// parts: [{ id, text, stable?: boolean }]；稳定块按 id 排序放前面，易变块放后面
export function buildStablePrefix(parts) {
  const stable = parts.filter((p) => p.stable !== false).sort((a, b) => a.id.localeCompare(b.id));
  const tail = parts.filter((p) => p.stable === false);
  const prefix = stable.map((p) => p.text).join('\n\n');
  return {
    prefix, tail: tail.map((p) => p.text).join('\n\n'),
    hash: createHash('sha256').update(prefix).digest('hex').slice(0, 16),
    approxTokens: approxTokens(prefix), warnings: lintPrefix(prefix),
  };
}

// 监视前缀哈希：变化意味着缓存失效
export class PrefixWatch {
  constructor() { this.last = null; this.misses = 0; }
  check(hash) {
    const changed = this.last !== null && this.last !== hash;
    if (changed) this.misses += 1;
    this.last = hash;
    return { changed, misses: this.misses };
  }
}
