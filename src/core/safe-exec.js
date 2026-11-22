// 命令执行加固 + 日志脱敏。注意：denylist 不是沙箱，只是拦住最明显的误操作；
// 真正隔离请在容器/受限用户下运行。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)/i;

export const DEFAULT_DENY = [
  /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME)(\s|$)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+[^|;]*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell)\b/i,
  /\bformat\s+[a-z]:/i,
  /\bgit\s+push\b[^|;]*--force/i,
];

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/gi, 'Bearer [REDACTED]'],
  [/((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)(['"]?)[^\s'"]{6,}\2/gi, '$1[REDACTED]'],
];

export function redact(text) {
  let s = String(text ?? '');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

export function redactDeep(v, key = '') {
  if (SECRET_NAME.test(key) && v != null && typeof v !== 'object') return '[REDACTED]';
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, k)]));
  return v;
}

export function cleanEnv(env = process.env, keep = []) {
  const out = {};
  for (const [k, val] of Object.entries(env)) {
    if (SECRET_NAME.test(k) && !keep.includes(k)) continue;
    out[k] = val;
  }
  return out;
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

export function runSafe(command, opts = {}) {
  const {
    cwd = process.cwd(), timeoutMs = 120_000, maxChars = 64 * 1024,
    deny = DEFAULT_DENY, allow = null, env = process.env, keepEnv = [], redactOutput = true,
  } = opts;
  const refuse = (reason) => Promise.resolve({
    ok: false, denied: true, reason, exitCode: null, signal: null,
    timedOut: false, truncated: false, stdout: '', stderr: '', durationMs: 0,
  });
  const hit = deny.find((r) => r.test(command));
  if (hit) return refuse(`matched deny rule ${hit}`);
  if (allow && !allow.some((r) => r.test(command))) return refuse('not in allowlist');

  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', err = '', used = 0, truncated = false, timedOut = false, settled = false;
    const child = spawn(command, {
      cwd, shell: true, env: cleanEnv(env, keepEnv), windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const take = (buf, isOut) => {
      const s = buf.toString('utf8');
      const room = maxChars - used;
      if (room <= 0) { truncated = true; return; }
      const piece = s.length > room ? s.slice(0, room) : s;
      if (piece.length < s.length) truncated = true;
      used += piece.length;
      if (isOut) out += piece; else err += piece;
    };
    child.stdout.on('data', (b) => take(b, true));
    child.stderr.on('data', (b) => take(b, false));
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const done = (exitCode, signal, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const f = redactOutput ? redact : (x) => x;
      resolve({
        ok: exitCode === 0 && !timedOut, denied: false, exitCode, signal, timedOut, truncated,
        stdout: f(out), stderr: f(err + extra), durationMs: Date.now() - t0,
      });
    };
    child.on('error', (e) => done(null, null, String(e.message)));
    child.on('close', (code, signal) => done(code, signal));
  });
}

// 追加写 jsonl：先脱敏，再按体积轮转（保留一个 .1 备份）
export async function appendJsonlCapped(file, obj, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const line = JSON.stringify(redactDeep(obj)) + '\n';
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const st = await fs.stat(file);
    if (st.size + line.length > maxBytes) await fs.rename(file, file + '.1');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.appendFile(file, line);
}
