/**
 * DeepSeek 计费与账户 —— 转录扫描 / 官方口径费用 / 余额 / 增量（CommonJS，零依赖）
 *
 * 分两条路，因为状态栏每秒都要重画:
 *   refreshAccount()  重活: 扫 transcript + 可能拉余额, 结果写 cache/account.json（事件驱动 + 30 秒兜底时跑）
 *   readAccount()     轻活: 只读那一份缓存（每秒 tick 跑）
 *
 * 计费口径见 peak-hours.cjs（官方人民币价，分高峰/空闲；输入分缓存命中/未命中）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const PEAK = require(path.join(__dirname, 'peak-hours.cjs'));

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR.trim().replace(/^~(?=[\\/]|$)/, HOME))
  : path.join(HOME, '.claude');
// DS_CACHE_DIR 是给自检/排障用的旋钮：把缓存指到别处，就能在不碰真实 cache/ 的前提下跑完整渲染。
// 默认仍是安装目录下的 cache/（install.mjs 升级时刻意保留它，别改这个默认值）。
const CACHE_DIR = process.env.DS_CACHE_DIR?.trim()
  ? path.resolve(process.env.DS_CACHE_DIR.trim().replace(/^~(?=[\\/]|$)/, HOME))
  : path.join(__dirname, '..', 'cache');
const ACCOUNT_CACHE = path.join(CACHE_DIR, 'account.json');
const BALANCE_FILE = path.join(CACHE_DIR, 'balance.json');
const BALANCE_LOCK = path.join(CACHE_DIR, 'balance.lock');
const BALANCE_FETCHER = path.join(__dirname, 'fetch-balance.mjs');

const BALANCE_TTL_MS = 60e3;        // 余额值超过 1 分钟就派后台去刷新
const COST_TTL_MS = 20e3;           // 费用最多 20 秒重扫一次
const BALANCE_SPAWN_MIN_MS = 15e3;  // 两次派发之间至少隔 15 秒（网络慢时别每秒派一个）

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const MAX_KEY_ATTEMPTS = 3;  // 最多试几把**不同**的 key（只有 401/403 才值得换下一把）
/** 字段序处处一致，便于记忆：DEEPSEEK_API_KEY → ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY */
const KEY_FIELDS = ['DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

const MIN = 60e3, HOUR = 3600e3;
/**
 * 失败后各原因退避多久。**硬失败退很久**，因为一把永久错误的 key 按 15 秒重试
 * 是每小时约 240 次进程 spawn + 240 次 HTTPS，全部徒劳。429 单独给 5 分钟。
 */
const BACKOFF_MS = {
  nokey: Infinity,   // 没有 key 就永远不派进程（本来也发不出请求）
  auth: 6 * HOUR,
  http: MIN,
  parse: 30 * MIN,
  net: 30e3,
  unknown: 30e3,
};

function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}

// ── 格式化 ──
function fmtCost(n) {
  if (!(n > 0)) return '¥0';
  if (n < 0.0001) return '¥0';
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  if (n < 1) return `¥${n.toFixed(3)}`;
  return `¥${n.toFixed(2)}`;
}
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// ── 转录 ──
/** 从 stdin 载荷取 transcript 路径；没有就给 null */
function transcriptFrom(stdin) {
  const p = stdin?.transcript_path;
  return typeof p === 'string' && p ? p : null;
}

/** 没有 stdin 时（CLI 用法）：取最新的 session 转录 */
function newestTranscript() {
  const dir = path.join(CLAUDE_DIR, 'projects');
  let newest = null;
  let newestTime = 0;
  try {
    for (const sub of fs.readdirSync(dir)) {
      const subDir = path.join(dir, sub);
      let stat;
      try { stat = fs.statSync(subDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(subDir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs > newestTime) { newestTime = st.mtimeMs; newest = { path: fp, id: f.replace('.jsonl', '') }; }
      }
    }
  } catch { /* ignore */ }
  return newest;
}

/**
 * 扫一份转录，按官方口径算钱。
 * 去重：同一个响应 Claude Code 会写 2-3 次 —— 优先按 message.id 去重，没 id 时退回"相邻相同即重复"。
 * 返回 { calls, miss, hit, out, totalIn, ctxPeak, modelKey, modelId, buckets, cost, cachePct }
 */
function scanTranscript(jsonlPath) {
  let miss = 0, hit = 0, out = 0, calls = 0, ctxPeak = 0, modelId = '';
  const buckets = { peak: PEAK.emptyBucket(), offPeak: PEAK.emptyBucket() };
  const seen = new Set();
  let lastKey;
  const text = fs.readFileSync(jsonlPath, 'utf-8');
  for (const line of text.split('\n')) {
    if (!line.trim()) { lastKey = undefined; continue; }
    let e;
    try { e = JSON.parse(line); } catch { lastKey = undefined; continue; }
    const m = e.message;
    const u = m && m.usage;
    if (!(e.type === 'assistant' && u)) { lastKey = undefined; continue; }
    const key = `${u.input_tokens}|${u.output_tokens}|${u.cache_creation_input_tokens}|${u.cache_read_input_tokens}`;
    if (m.id ? seen.has(m.id) : key === lastKey) continue;
    if (m.id) seen.add(m.id);
    lastKey = key;

    const mi = u.input_tokens || 0;
    const cc = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const o = u.output_tokens || 0;
    if (m.model) modelId = m.model;

    const b = PEAK.isPeak(e.timestamp) ? buckets.peak : buckets.offPeak;
    b.inputTokens += mi; b.cacheCreationTokens += cc; b.cacheReadTokens += cr; b.outputTokens += o;

    miss += mi + cc;
    hit += cr;
    out += o;
    ctxPeak = Math.max(ctxPeak, mi + cc + cr);
    calls += 1;
  }
  const modelKey = PEAK.pickModel(modelId);
  const cost = PEAK.costFromBuckets(buckets, modelKey, Date.now()) || { total: 0, peak: 0, offPeak: 0 };
  const totalIn = miss + hit;
  return {
    calls, miss, hit, out, totalIn, ctxPeak, modelKey, modelId, buckets, cost,
    cachePct: totalIn > 0 ? (hit / totalIn) * 100 : 0,
  };
}

// ── 密钥来源 ──
// 为什么这么多来源：朋友的余额一直不显示，根因之一就是旧版只认两处
// （DEEPSEEK_API_KEY 环境变量、~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN）。
// 密钥可能只存在于进程环境变量（cc-switch 之类工具导出的）、settings.local.json、
// 或项目级 settings 里 —— 全都认，然后逐个试，才叫通用适配。
//
// 明确**不做**的来源：cc-switch 的 SQLite 库（它的效果本来就写在 ANTHROPIC_AUTH_TOKEN /
// ANTHROPIC_BASE_URL 上，读 env + settings 已覆盖；读 SQLite 要 node:sqlite，破坏零依赖）；
// settings.apiKeyHelper（诊断里检测并报告，但**绝不执行** —— 在每 15 秒触发一次的进程里
// 跑任意 shell 命令是性能与安全问题）；dotenv（Claude Code 不读）。

/** 托管配置路径（Claude Code 自己的最高优先级来源） */
function managedSettingsPath() {
  return process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')
    : '/etc/claude-code/managed-settings.json';
}

/**
 * 来源清单，顺序即优先级。settings.local.json 排在 settings.json 前，因为 Claude Code 同级 local 覆盖 base。
 * managed 可注入 —— 否则一台真有托管配置的机器上自检会误判优先级。
 */
function keySourceList({ claudeDir, cwd, managed = managedSettingsPath() }) {
  const list = KEY_FIELDS.map((f) => ({ id: `env:${f}`, label: `env  ${f}`, kind: 'env', field: f }));
  const files = [
    [managed, '托管  managed-settings.json'],
    [path.join(claudeDir, 'settings.local.json'), '~/.claude/settings.local.json'],
    [path.join(claudeDir, 'settings.json'), '~/.claude/settings.json'],
    [path.join(cwd, '.claude', 'settings.local.json'), './.claude/settings.local.json'],
    [path.join(cwd, '.claude', 'settings.json'), './.claude/settings.json'],
  ];
  for (const [file, label] of files) if (file) list.push({ id: `file:${file}`, label, kind: 'file', file });
  return list;
}

/** 从一个来源里取出第一把非空 key → { key, field } | null */
function keyFromSource(src, env) {
  if (src.kind === 'env') {
    const v = String(env?.[src.field] ?? '').trim();
    return v ? { key: v, field: src.field } : null;
  }
  const j = readJson(src.file);
  const e = j && typeof j === 'object' ? j.env : null;
  if (!e || typeof e !== 'object') return null;
  for (const f of KEY_FIELDS) {
    const v = String(e[f] ?? '').trim();
    if (v) return { key: v, field: f };
  }
  return null;
}

/** 打码。原则：**露出不超过一半、总数不超过 10 个字符**；短密钥直接全遮（露头就等于泄露）。 */
function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  if (s.length < 12) return '…';
  const head = Math.min(6, Math.floor(s.length / 4));
  const tail = Math.min(4, Math.floor(s.length / 4));
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** sha256 前 8 位十六进制 —— 用来跨机器比对"是不是同一把 key"，不可逆 */
function keyFingerprint(key) {
  return crypto.createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 8);
}

/** 粗判密钥的家族，只用于给提示（sk-ant- 是 Anthropic 的，DeepSeek 是 sk- + 32 位十六进制）。 */
function keyLooksLike(key) {
  const s = String(key ?? '');
  if (s.startsWith('sk-ant-')) return 'anthropic';
  if (s.startsWith('sk-')) return 'deepseek';
  return null;
}

/**
 * 诊断用：逐个来源报现状，**不去重**。
 * → [{ id, label, state:'present'|'empty'|'missing'|'nokey'|'unreadable', field, value: 掩码, keyFp, dupOf }]
 * dupOf = 该值首次出现在第几个来源（1-based），用来把"同一把 key 出现在五处"讲清楚。
 */
function listKeySources({ claudeDir = CLAUDE_DIR, env = process.env, cwd = process.cwd(), managed } = {}) {
  const seen = new Map();
  return keySourceList({ claudeDir, cwd, managed }).map((src, i) => {
    const base = { id: src.id, label: src.label, kind: src.kind, field: null, value: null, keyFp: null, looksLike: null, dupOf: null };
    if (src.kind === 'file') {
      try { fs.readFileSync(src.file, 'utf-8'); } catch (e) {
        return { ...base, state: e?.code === 'ENOENT' ? 'missing' : 'unreadable' };
      }
    }
    const hit = keyFromSource(src, env);
    if (!hit) return { ...base, state: src.kind === 'env' ? (String(env?.[src.field] ?? '') ? 'empty' : 'missing') : 'nokey' };
    let at = seen.get(hit.key);
    if (at === undefined) { at = i + 1; seen.set(hit.key, at); }
    return {
      ...base, state: 'present', field: hit.field,
      value: maskKey(hit.key), keyFp: keyFingerprint(hit.key), looksLike: keyLooksLike(hit.key),
      dupOf: at === i + 1 ? null : at,
    };
  });
}

/**
 * 尝试用：按优先级取值、按值去重。→ [{ key, source, sources:[全部同值来源的 label] }]
 * 这是唯一把明文 key 交给调用方的地方 —— 只该在抓取进程里调用，别进渲染路径。
 */
function resolveApiKeys({ claudeDir = CLAUDE_DIR, env = process.env, cwd = process.cwd(), managed } = {}) {
  const out = [];
  const byKey = new Map();
  for (const src of keySourceList({ claudeDir, cwd, managed })) {
    const hit = keyFromSource(src, env);
    if (!hit) continue;
    const prev = byKey.get(hit.key);
    if (prev) { prev.sources.push(src.label); continue; }
    const rec = { key: hit.key, source: src.label, sources: [src.label] };
    byKey.set(hit.key, rec);
    out.push(rec);
  }
  return out;
}

/** 当前生效的 ANTHROPIC_BASE_URL → { raw, host, isDeepSeek, source }。用来判断"token 是不是中转站的"。 */
function resolveBaseUrl({ claudeDir = CLAUDE_DIR, env = process.env, cwd = process.cwd(), managed } = {}) {
  const finish = (raw, source) => {
    let host = '';
    try { host = new URL(raw).host; } catch { /* 解析不了就留空 host */ }
    return { raw, host, isDeepSeek: /(^|\.)deepseek\.com$/i.test(host), source };
  };
  const fromEnv = String(env?.ANTHROPIC_BASE_URL ?? '').trim();
  if (fromEnv) return finish(fromEnv, 'env');
  for (const src of keySourceList({ claudeDir, cwd, managed })) {
    if (src.kind !== 'file') continue;
    const j = readJson(src.file);
    const v = j && typeof j === 'object' && j.env ? String(j.env.ANTHROPIC_BASE_URL ?? '').trim() : '';
    if (v) return finish(v, src.label);
  }
  return { raw: '', host: '', isDeepSeek: false, source: null };
}

// ── 余额抓取 ──
/**
 * 一次 GET，**永不抛**。超时/网络错一律 → { status: 0, body: '' }，让调用方靠 status 区分原因。
 * 这是注入点：自检传一个假的 request 就能离线模拟 200 / 401 / 网络错。
 */
function httpsRequest(url, { headers, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = https.request(url, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => finish({ status: res.statusCode || 0, body }));
        res.on('error', () => finish({ status: 0, body: '' }));
      });
    } catch { finish({ status: 0, body: '' }); return; }
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '' }); });
    req.on('error', () => finish({ status: 0, body: '' }));
    req.end();
  });
}

/**
 * 解析余额响应 → { total, topped, granted, available } | null。
 *
 * **total_balance 缺失是失败（null），不是 0** —— 旧版写的是 `parseFloat(...) || 0`，
 * 于是一个返回 JSON 的代理/校园网劫持页会被当成"余额 ¥0.00"的**成功值**显示出来。
 * 那是个假数字，比不显示更糟。
 */
function parseBalanceBody(body) {
  let j;
  try { j = JSON.parse(body); } catch { return null; }
  const b = Array.isArray(j?.balance_infos) ? j.balance_infos[0] : null;
  if (!b || b.total_balance == null) return null;
  return {
    total: parseFloat(b.total_balance) || 0,
    topped: parseFloat(b.topped_up_balance) || 0,
    granted: parseFloat(b.granted_balance) || 0,
    available: j.is_available === true,
  };
}

const REASON_CODES = new Set(['nokey', 'auth', 'http', 'parse', 'net', 'unknown']);

/** HTTP 状态 → 原因码 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (!status) return 'net';
  return 'http';
}

/** 该原因要退避多久（毫秒） */
function reasonBackoffMs(code, status) {
  if (code === 'nokey') return Infinity;
  if (code === 'http' && status === 429) return 5 * MIN;
  return BACKOFF_MS[code] ?? BACKOFF_MS.unknown;
}

/** 状态栏上的原因文案。机器码是细分的，**显示归并成四种**：无key / 401 / 网络 / 异常。 */
function reasonText(reason, lang) {
  const zh = String(lang || '').toLowerCase().startsWith('zh');
  switch (reason?.code) {
    case 'nokey': return zh ? '无key' : 'no-key';
    case 'auth': return '401';
    case 'net': return zh ? '网络' : 'network';
    default: return zh ? '异常' : 'resp';
  }
}

/**
 * 抓一次余额。第一个参数仍是超时（**每次尝试**的超时），既有调用点都传 5000。
 *
 * 返回**记录**（成功或失败），不再是 value|null —— 失败必须留下原因，否则没有守卫可言。
 * 只有 401/403 才换下一把 key；网络错 / 5xx / 解析失败都是主机级问题，换 key 没用，立即停。
 */
async function fetchBalance(timeoutMs = 3000, { keys, request = httpsRequest, now = Date.now } = {}) {
  const at = now();
  const cands = (keys ?? resolveApiKeys()).slice(0, MAX_KEY_ATTEMPTS);
  if (!cands.length) {
    return { ok: false, code: 'nokey', status: null, at, source: null, keyFp: null, retryAt: Infinity, attempts: [] };
  }
  const attempts = [];
  let last = null;
  for (const c of cands) {
    const res = await request(BALANCE_URL, { headers: { Authorization: `Bearer ${c.key}` }, timeoutMs });
    if (res.status === 200) {
      const parsed = parseBalanceBody(res.body);
      if (parsed) {
        attempts.push({ source: c.source, status: 200, code: 'ok' });
        return { ok: true, ...parsed, at: now(), source: c.source, keyFp: keyFingerprint(c.key), attempts };
      }
      attempts.push({ source: c.source, status: 200, code: 'parse' });
      last = { code: 'parse', status: 200 };
      break;  // 主机级：换 key 没用
    }
    const code = codeForStatus(res.status);
    attempts.push({ source: c.source, status: res.status, code });
    last = { code, status: res.status };
    if (code !== 'auth') break;  // 只有被拒才值得换下一把
  }
  const code = last?.code ?? 'unknown';
  const status = last?.status ?? null;
  return {
    ok: false, code, status, at,
    source: attempts.at(-1)?.source ?? null,
    // 失败记录里的指纹取**首候选**那把：planBalanceFetch 就是拿它跟首候选比，好让"换了 key"立刻生效
    keyFp: keyFingerprint(cands[0].key),
    retryAt: at + reasonBackoffMs(code, status),
    attempts,
  };
}

// ── 余额记录：读 / 归一化 / 派发 ──
/**
 * 归一化 balance.json —— **新旧格式都认**。
 * v0.1.1 写成功是 `{total,…,at}`、失败是 `{error:true,at}`；新版成功带 ok:true，失败带 code/retryAt。
 * 升级后 cache/ 是被刻意保留的（install.mjs），所以旧文件一定会被读到，必须优雅处理。
 */
function normalizeBalanceRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.total === 'number') {
    return {
      ok: true, total: raw.total, topped: raw.topped || 0, granted: raw.granted || 0,
      available: raw.available === true, at: raw.at || 0,
      source: raw.source ?? null, keyFp: raw.keyFp ?? null,
      attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
    };
  }
  if (raw.error === true && raw.code == null) {
    // 旧版的失败标记：没有原因可讲，只能算"异常"。下次抓取就会自纠，所以退避很短。
    const at = raw.at || 0;
    return { ok: false, code: 'unknown', status: null, at, source: null, keyFp: null, retryAt: at + BACKOFF_MS.unknown, attempts: [] };
  }
  if (raw.ok === false) {
    const code = REASON_CODES.has(raw.code) ? raw.code : 'unknown';
    const status = typeof raw.status === 'number' ? raw.status : null;
    const at = raw.at || 0;
    return {
      ok: false, code, status, at, source: raw.source ?? null, keyFp: raw.keyFp ?? null,
      retryAt: typeof raw.retryAt === 'number' ? raw.retryAt : at + reasonBackoffMs(code, status),
      attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
    };
  }
  return null;
}

/** 从记录里剥出渲染要用的值（字段形状与旧版一字不差） */
function balanceValueOf(rec) {
  if (!rec || !rec.ok) return null;
  return { total: rec.total, topped: rec.topped, granted: rec.granted, available: rec.available, at: rec.at };
}

/** balance.json 的原始记录（成功或失败），已归一化 */
function readBalanceRecord(file = BALANCE_FILE) { return normalizeBalanceRecord(readJson(file)); }

/** 只取可用余额值；语义与旧版逐字一致（没有就 null） */
function readBalanceCache(file = BALANCE_FILE) {
  return balanceValueOf(readBalanceRecord(file));
}

/** 失败原因记录；成功或没记录时 null */
function readBalanceStatus(file = BALANCE_FILE) {
  const r = readBalanceRecord(file);
  return r && !r.ok ? r : null;
}

/** 唯一的写入点：fetch-balance.mjs 与 --refresh 共用 */
function writeBalanceRecord(rec, file = BALANCE_FILE) {
  writeJson(file, rec);
  return rec;
}

/**
 * 纯函数：这一轮要不要派后台抓余额。→ { spawn: bool, reason: 失败记录|null }
 *
 * 退避必须配**指纹逃逸**：retryAt 只在 key 指纹没变时才算数。否则会出现
 * "我换了新 key，它还说 401、还让我等到明天" —— 那才是真正的陷阱。
 * 没有候选时永远不派进程（nokey 是同步可得的，不需要网络）。
 */
function planBalanceFetch({ keys, record, now = Date.now(), force = false } = {}) {
  const cands = keys ?? resolveApiKeys();
  if (!cands.length) {
    return { spawn: false, reason: normalizeBalanceRecord({ ok: false, code: 'nokey', at: now, retryAt: Infinity }) };
  }
  if (record && !record.ok) {
    const sameKey = record.keyFp == null || record.keyFp === keyFingerprint(cands[0].key);
    if (!force && sameKey && typeof record.retryAt === 'number' && record.retryAt > now) {
      return { spawn: false, reason: record };   // 退避中
    }
    return { spawn: true, reason: record };      // 退避过了，或者换了 key
  }
  if (record && record.ok) {
    return { spawn: force || now - (record.at || 0) > BALANCE_TTL_MS, reason: null };
  }
  return { spawn: true, reason: null };          // 还没有任何记录
}

/**
 * 派一个游离进程去抓余额。三道闸：① 无候选不派 ② 退避中不派 ③ .lock 的 mtime 节流 15 秒。
 * 用 .lock 的 mtime 当节流阀：网络慢或抓失败时，每秒一次的 tick 也不会各派一个进程。
 *
 * **绝不把 key 传给子进程**（argv 和 env 都不行）—— 那会把密钥暴露在任务管理器的命令行列里。
 * 子进程自己重新解析。别"优化"这一点。
 */
function spawnBalanceFetch({ keys, record, now = Date.now(), force = false } = {}) {
  const plan = planBalanceFetch({ keys, record: record ?? readBalanceRecord(), now, force });
  if (!plan.spawn) return false;
  try {
    const st = fs.statSync(BALANCE_LOCK);
    if (Date.now() - st.mtimeMs < BALANCE_SPAWN_MIN_MS) return false;
  } catch { /* 没有锁就派 */ }
  try {
    ensureCacheDir();
    fs.writeFileSync(BALANCE_LOCK, String(Date.now())); // 先占锁再派，避免并发
    const child = spawn(process.execPath, [BALANCE_FETCHER], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch { return false; }  // 派不出去就继续用旧值
}

// ── 缓存读写 ──
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}
function writeJson(file, data) {
  ensureCacheDir();
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch { /* ignore */ }
}

/**
 * 重活：重扫转录、按 TTL 决定要不要拉余额，把结果落到 cache/account.json。
 * 返回刚写下的对象；转录读不出来时返回上一次的缓存（或 null）。
 */
/** 两次余额状态是否等价（决定要不要重写 account.json）。
 *  刻意**不比原因里的 at** —— 否则一个长期 nokey 会每 30 秒重写一次盘，永远。 */
function sameBalanceState(a, b, ra, rb) {
  return (a?.at ?? null) === (b?.at ?? null)
    && (ra?.code ?? null) === (rb?.code ?? null)
    && (ra?.status ?? null) === (rb?.status ?? null);
}

async function refreshAccount({ transcriptPath, force = false, spawnBalance = true } = {}) {
  const prev = readJson(ACCOUNT_CACHE);
  const now = Date.now();

  // 余额的刷新判断放在最前面：费用那边会提前返回，不该把余额一起挡住
  const record = readBalanceRecord();
  const balance = balanceValueOf(record) ?? prev?.balance ?? null;   // 沿用"退到上次好值"
  const keys = resolveApiKeys();
  const plan = planBalanceFetch({ keys, record, now, force });
  if (spawnBalance && plan.spawn) spawnBalanceFetch({ keys, record, now, force });

  // **完全没有可用余额值**时才渲染原因。有上次的好值就照旧显示（房子规约：降级到好值），
  // 这也是"成功路径逐字节不变"的唯一办法 —— 别把 (401) 拼到那个陈旧的真值后面。
  const balanceStatus = balance ? null : plan.reason;

  if (!force && prev && now - (prev.costAt || 0) < COST_TTL_MS) {
    if (sameBalanceState(prev.balance, balance, prev.balanceStatus, balanceStatus)) return prev;
    const patched = { ...prev, balance, balanceStatus };
    writeJson(ACCOUNT_CACHE, patched);
    return patched;
  }

  const tp = transcriptPath || prev?.transcriptPath || newestTranscript()?.path || null;
  let scan = null;
  if (tp) {
    try { scan = scanTranscript(tp); } catch { scan = null; }
  }
  const costTotal = scan ? scan.cost.total : (prev?.cost?.total ?? 0);

  // 增量：与上次展示过的值比（跨进程，落在缓存里）
  const lastShown = typeof prev?.shownCost === 'number' ? prev.shownCost : null;
  const delta = lastShown !== null && costTotal > lastShown ? costTotal - lastShown : 0;

  const next = {
    transcriptPath: tp,
    costAt: now,
    cost: scan ? scan.cost : (prev?.cost ?? { total: 0, peak: 0, offPeak: 0 }),
    tokens: scan ? { miss: scan.miss, hit: scan.hit, out: scan.out, totalIn: scan.totalIn, ctxPeak: scan.ctxPeak, calls: scan.calls } : (prev?.tokens ?? null),
    modelKey: scan ? scan.modelKey : (prev?.modelKey ?? 'flash'),
    modelId: scan ? scan.modelId : (prev?.modelId ?? ''),
    cachePct: scan ? scan.cachePct : (prev?.cachePct ?? 0),
    delta,
    shownCost: costTotal,
    balance,
    balanceStatus,
  };
  writeJson(ACCOUNT_CACHE, next);
  return next;
}

/** 轻活：只读缓存（每秒 tick 用，不碰转录、不联网） */
function readAccount() {
  return readJson(ACCOUNT_CACHE);
}

/** 状态栏那段账户文案：`费用 +¥0.0084 ¥3.10  余额 ¥42.00 12s  v0.1.0`
 *  排版与色彩沿用原来那个监控插件的样子（增量黄/超 0.5 元红、累计暗、余额按金额变色、余额后带缓存秒数、末尾版本号）。 */
const DIM = '\x1b[2m', RESET = '\x1b[0m', YELLOW = '\x1b[33m', RED = '\x1b[31m';
const ALERT_COST = 0.5;     // 单次增量超过它标红（与原实现一致）
const STALE_BALANCE_S = 150; // 余额超过它算陈旧，补一个 ⚠

function rainbowBalance(n) {
  if (n <= 0.5) return '\x1b[38;5;196m';
  if (n <= 1) return '\x1b[38;5;202m';
  if (n <= 3) return '\x1b[38;5;208m';
  if (n <= 5) return '\x1b[38;5;214m';
  if (n <= 8) return '\x1b[38;5;220m';
  if (n <= 12) return '\x1b[38;5;190m';
  if (n <= 20) return '\x1b[38;5;82m';
  if (n <= 50) return '\x1b[38;5;51m';
  return '\x1b[38;5;33m';
}

let cachedVersion;
/** 本插件版本（安装目录下的 VERSION，仓库里则退回 package.json） */
function version() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf-8').trim();
  } catch {
    try { cachedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version; } catch { cachedVersion = ''; }
  }
  return cachedVersion;
}

/** 钱那一段（放在第 1 行末尾）；什么都没有就返回空串，不占位 */
function moneySegment(account, lang) {
  const zh = String(lang || '').toLowerCase().startsWith('zh');
  const parts = [];
  const total = account?.cost?.total ?? 0;
  if (total > 0) {
    const delta = account?.delta ?? 0;
    const cum = `${DIM}${fmtCost(total)}${RESET}`;
    const costStr = delta > ALERT_COST && delta > 0.0001
      ? `${RED}+${fmtCost(delta)}${RESET} ${cum}`
      : delta > 0.0001
        ? `${YELLOW}+${fmtCost(delta)}${RESET} ${cum}`
        : `${YELLOW}${fmtCost(total)}${RESET}`;
    parts.push(`${DIM}${zh ? '费用' : 'cost'}${RESET} ${costStr}`);
  }
  const bal = account?.balance;
  if (bal && typeof bal.total === 'number') {
    const ageS = bal.at ? Math.max(0, Math.round((Date.now() - bal.at) / 1000)) : 0;
    const warn = ageS > STALE_BALANCE_S ? ` ${RED}⚠${RESET}` : '';
    parts.push(`${DIM}${zh ? '余额' : 'bal'}${RESET} ${rainbowBalance(bal.total)}¥${bal.total.toFixed(2)}${RESET}${warn} ${DIM}${ageS}s${RESET}`);
  } else {
    // 守卫：完全没有可用余额值时，把**原因**显示出来，别再静默留空。
    // 只在没有可用值时走这里 —— 有上次的好值就照上面那条渲染（见 refreshAccount 的注释）。
    const txt = account?.balanceStatus ? reasonText(account.balanceStatus, lang) : '';
    if (txt) parts.push(`${DIM}${zh ? '余额' : 'bal'}${RESET} ${DIM}n/a(${txt})${RESET}`);
  }
  const v = version();
  if (v) parts.push(`${DIM}v${v}${RESET}`);
  return parts.join('  ');
}

/** 峰谷那段（放在最后一行末尾）：`🟢DS谷 12h37m36s | 20:22:23` */
function peakSegment(lang, now = Date.now()) {
  return `${PEAK.peakBadge(now, lang)} | ${PEAK.bjClock(now)}`;
}

/**
 * 诊断提示：给最可能的原因一句可执行的修法。纯函数，便于自检。
 * → { zh, en } | null
 */
function hintFor({ reason, base, sources, source } = {}) {
  const code = reason?.code;
  const status = reason?.status ?? null;
  const present = (Array.isArray(sources) ? sources : []).filter((s) => s.state === 'present');
  const relay = !!base?.raw && !base.isDeepSeek;
  const anthropicish = present.some((s) => s.looksLike === 'anthropic');
  // 点名实际用的是哪一处密钥（诊断里传进来），别写死成 ANTHROPIC_AUTH_TOKEN
  const used = source || reason?.source || null;

  if (code === 'nokey') return {
    zh: '所有来源都没找到密钥。设 DEEPSEEK_API_KEY，或写进 settings.json 的 env.ANTHROPIC_AUTH_TOKEN。',
    en: 'No key in any source. Set DEEPSEEK_API_KEY, or put it in settings.json env.ANTHROPIC_AUTH_TOKEN.',
  };
  if (code === 'auth' && relay) return {
    zh: `base URL 指向 ${base.host}（中转站）：在用的密钥${used ? `（来自 ${used}）` : ''}是**中转站的 token**，在 api.deepseek.com 上无效。\n`
      + '      修法：去 platform.deepseek.com 生成一把 DeepSeek 平台密钥，放进 DEEPSEEK_API_KEY\n'
      + '      （或 settings.json 的 env.DEEPSEEK_API_KEY）。只有余额那一段用它，其余段不受影响。',
    en: `Your base URL points at ${base.host} (a relay): the key in use${used ? ` (from ${used})` : ''} is the RELAY's token, which api.deepseek.com rejects.\n`
      + '      Fix: create a DeepSeek platform key at platform.deepseek.com and put it in DEEPSEEK_API_KEY\n'
      + '      (or settings.json env.DEEPSEEK_API_KEY). Only the balance segment uses it.',
  };
  if (code === 'auth' && anthropicish) return {
    zh: '密钥看着是 Anthropic 的（sk-ant-…），DeepSeek 平台不认。换一把 DeepSeek 平台的密钥。',
    en: 'That key looks like an Anthropic one (sk-ant-…), which DeepSeek rejects. Use a DeepSeek platform key.',
  };
  if (code === 'auth') return {
    zh: '密钥被拒：写错了、已被删除，或复制时带了空格/引号。重新生成一把。',
    en: 'The key was rejected: typo, revoked, or stray whitespace/quotes. Generate a fresh one.',
  };
  if (code === 'http' && status === 429) return {
    zh: '被限流（429），退避 5 分钟后自会重试。',
    en: 'Rate limited (429); backing off 5 minutes, then it retries.',
  };
  if (code === 'http') return {
    zh: `DeepSeek 端返回 ${status}，退避 60 秒后重试。`,
    en: `DeepSeek returned ${status}; retrying after a 60 s backoff.`,
  };
  if (code === 'parse') return {
    zh: '返回不是预期的 JSON —— 可能被公司代理/校园网劫持插了页面，也可能接口变了。',
    en: 'The response was not the expected JSON — a corporate proxy / captive portal may be injecting a page.',
  };
  if (code === 'net') return {
    zh: '连不上 api.deepseek.com：离线、代理、DNS 或防火墙。',
    en: 'Cannot reach api.deepseek.com: offline, proxy, DNS, or firewall.',
  };
  if (code === 'unknown') return {
    zh: '上一次抓取的失败原因不明（多半是旧版本写下的记录），下次抓取就会自纠。',
    en: 'The last failure has no recorded reason (likely written by an older version); the next fetch self-corrects.',
  };
  if (!base?.raw) return {
    zh: '没有 ANTHROPIC_BASE_URL。如果你本来就没在用 DeepSeek 后端，余额那一段本来就没意义。',
    en: 'No ANTHROPIC_BASE_URL. If you are not on a DeepSeek backend, the balance segment is meaningless anyway.',
  };
  return null;
}

module.exports = {
  CLAUDE_DIR, CACHE_DIR, ACCOUNT_CACHE, BALANCE_FILE, BALANCE_LOCK,
  BALANCE_TTL_MS, COST_TTL_MS, BALANCE_SPAWN_MIN_MS, BALANCE_URL, MAX_KEY_ATTEMPTS, KEY_FIELDS,
  fmtCost, fmtTokens, version,
  transcriptFrom, newestTranscript, scanTranscript,
  maskKey, keyFingerprint, keyLooksLike, listKeySources, resolveApiKeys, resolveBaseUrl,
  httpsRequest, parseBalanceBody, codeForStatus, reasonBackoffMs, reasonText,
  fetchBalance, normalizeBalanceRecord, balanceValueOf,
  readBalanceRecord, readBalanceCache, readBalanceStatus, writeBalanceRecord,
  planBalanceFetch, spawnBalanceFetch,
  refreshAccount, readAccount, moneySegment, peakSegment, hintFor,
};
