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
const { spawn } = require('node:child_process');
const PEAK = require(path.join(__dirname, 'peak-hours.cjs'));

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR?.trim()
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR.trim().replace(/^~(?=[\\/]|$)/, HOME))
  : path.join(HOME, '.claude');
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const ACCOUNT_CACHE = path.join(CACHE_DIR, 'account.json');
const BALANCE_FILE = path.join(CACHE_DIR, 'balance.json');
const BALANCE_LOCK = path.join(CACHE_DIR, 'balance.lock');
const BALANCE_FETCHER = path.join(__dirname, 'fetch-balance.mjs');

const BALANCE_TTL_MS = 60e3;        // 余额值超过 1 分钟就派后台去刷新
const COST_TTL_MS = 20e3;           // 费用最多 20 秒重扫一次
const BALANCE_SPAWN_MIN_MS = 15e3;  // 两次派发之间至少隔 15 秒（网络慢时别每秒派一个）

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

// ── 余额 ──
function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf-8'));
    return s?.env?.ANTHROPIC_AUTH_TOKEN || '';
  } catch { return ''; }
}

function fetchBalance(timeoutMs = 3000) {
  const key = loadApiKey();
  if (!key) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = https.request(
      'https://api.deepseek.com/user/balance',
      { method: 'GET', headers: { Authorization: `Bearer ${key}` }, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            const b = (j.balance_infos || [{}])[0];
            resolve({
              total: parseFloat(b.total_balance) || 0,
              topped: parseFloat(b.topped_up_balance) || 0,
              granted: parseFloat(b.granted_balance) || 0,
              available: j.is_available === true,
              at: Date.now(),
            });
          } catch { resolve(null); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── 余额缓存与后台派发 ──
/** 读后台抓回来的余额 */
function readBalanceCache() {
  const d = readJson(BALANCE_FILE);
  return d && typeof d.total === 'number' ? d : null;
}

/**
 * 派一个游离进程去抓余额。用 .lock 的 mtime 当节流阀：网络慢或抓失败时，
 * 每秒一次的 tick 也不会各派一个进程。
 */
function spawnBalanceFetch() {
  try {
    const st = fs.statSync(BALANCE_LOCK);
    if (Date.now() - st.mtimeMs < BALANCE_SPAWN_MIN_MS) return;
  } catch { /* 没有锁就派 */ }
  try {
    ensureCacheDir();
    fs.writeFileSync(BALANCE_LOCK, String(Date.now())); // 先占锁再派，避免并发
    const child = spawn(process.execPath, [BALANCE_FETCHER], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { /* 派不出去就继续用旧值 */ }
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
async function refreshAccount({ transcriptPath, force = false } = {}) {
  const prev = readJson(ACCOUNT_CACHE);
  const now = Date.now();

  // 余额的刷新判断放在最前面：费用那边会提前返回，不该把余额一起挡住
  const balance = readBalanceCache() ?? prev?.balance ?? null;
  if (force || !balance || now - (balance.at || 0) > BALANCE_TTL_MS) {
    spawnBalanceFetch();
  }

  if (!force && prev && now - (prev.costAt || 0) < COST_TTL_MS) {
    return prev;
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
  }
  const v = version();
  if (v) parts.push(`${DIM}v${v}${RESET}`);
  return parts.join('  ');
}

/** 峰谷那段（放在最后一行末尾）：`🟢DS谷 12h37m36s | 20:22:23` */
function peakSegment(lang, now = Date.now()) {
  return `${PEAK.peakBadge(now, lang)} | ${PEAK.bjClock(now)}`;
}

module.exports = {
  CLAUDE_DIR, CACHE_DIR, ACCOUNT_CACHE, BALANCE_FILE,
  BALANCE_TTL_MS, COST_TTL_MS, BALANCE_SPAWN_MIN_MS,
  fmtCost, fmtTokens, version,
  transcriptFrom, newestTranscript, scanTranscript,
  loadApiKey, fetchBalance, readBalanceCache, spawnBalanceFetch,
  refreshAccount, readAccount, moneySegment, peakSegment,
};
