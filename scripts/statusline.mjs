// Claude Code 状态栏入口 —— 内嵌的 claude-hud + DeepSeek 附加段
//
//   <内嵌 HUD 的输出> ... | 费用 +¥0.0084 ¥3.10  余额 ¥42.00 12s  v0.1.0
//                        + 🟢DS谷 12h37m36s | 20:22:23
//
// 两条驱动路径（Claude Code 的 statusLine 只有一个 command、每次整块重渲染，
// 没法给"余额/费用"和"时钟/峰谷"各配一个触发器，所以拆在这里）：
//
//   便宜路径（每秒 tick，~40ms）：读缓存帧 + 读账户缓存 + 现算峰谷/时钟
//   完整路径（事件驱动 + 30 秒兜底，~250ms）：真跑一遍 HUD、重扫转录算钱、按需拉余额
//
// 为什么便宜路径不扫转录/不联网：转录可能好几 MB，余额是别人家的接口 —— 每秒做一遍是白烧。
// 失效判定不拿整包 stdin 做哈希（payload 里有 cost.total_duration_ms 这类每秒都变的计时器），
// 改用 transcript 的 size+mtime 当主信号，加 HUD 配置文件 mtime、版本、模型 id 等配置级字段。
//
// 用法（settings.json）:
//   "statusLine": { "type": "command", "command": "\"<node>\" \"<...>/scripts/statusline.mjs\"", "refreshInterval": 1 }
// 调试: node scripts/statusline.mjs < sample-stdin.json ；DS_PEAK_DISABLE=1 可只留 HUD
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VENDOR = join(ROOT, 'vendor', 'claude-hud', 'dist');
// DS_CACHE_DIR 与 ds-usage.cjs 的同名旋钮对齐：自检把缓存指到沙盒，就能整条链路跑完而不碰真实 cache/
const FRAME_CACHE = process.env.DS_CACHE_DIR?.trim()
  ? join(process.env.DS_CACHE_DIR.trim(), 'frame.json')
  : join(ROOT, 'cache', 'frame.json');
const FRAME_TTL_MS = 30e3;
const PEAK = require(join(HERE, 'peak-hours.cjs'));
const DS = require(join(HERE, 'ds-usage.cjs'));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const stdinRaw = await readStdin();
if (!stdinRaw.trim()) {
  // Claude Code 在"设置校验"时会不带 payload 调用一次；此时 HUD 只会回「初始化中」，不必渲染
  process.exit(0);
}
let stdin = null;
try { stdin = JSON.parse(stdinRaw); } catch { /* 交给 HUD 自己兜底 */ }

// CLAUDE_HUD_DISABLE / DS_PEAK_DISABLE：前者是上游的开关（整条状态栏静默），后者只关我们这段
// 这里自己解析（而不是调上游的 isHudDisabled）是为了不在便宜路径上 import HUD 的模块图 —— 那要 55ms
function envOff(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}
if (envOff('CLAUDE_HUD_DISABLE')) process.exit(0);
const showPeak = !envOff('DS_PEAK_DISABLE');

// ── 帧的失效 key：只用"便宜就能拿到"的配置级字段，刻意不哈希整包 stdin ──
function frameKey() {
  const parts = [];
  const tp = stdin?.transcript_path || '';
  parts.push(tp);
  if (tp) {
    try {
      const st = statSync(tp);
      parts.push(`${st.size}:${Math.round(st.mtimeMs)}`);
    } catch { parts.push('nostat'); }
  }
  const cfgPath = join(DS.CLAUDE_DIR, 'plugins', 'claude-hud', 'config.json');
  try { parts.push('cfg' + Math.round(statSync(cfgPath).mtimeMs)); } catch { /* 没有就是默认配置 */ }
  parts.push(stdin?.model?.id ?? '', stdin?.context_window?.context_window_size ?? '');
  return parts.join('|');
}

function readFrame(key) {
  try {
    const d = JSON.parse(readFileSync(FRAME_CACHE, 'utf8'));
    if (typeof d.frame === 'string' && d.key === key && Date.now() - d.t < FRAME_TTL_MS) return d;
  } catch { /* 没缓存 */ }
  return null;
}

/** 跑一遍内嵌 HUD，返回它的输出（捕获 stdout） */
async function runHud(hudModule, config) {
  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, enc, cb) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof enc === 'string' ? enc : 'utf8'));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    // stdin 已被我们读掉，必须交回给 HUD；否则它会走 "Running without stdin" 分支
    // loadConfig 也自己给：省一次文件读，并且把 DeepSeek 相关的开关钉死
    await hudModule.main({ readStdin: async () => stdin, loadConfig: async () => config });
  } catch (e) {
    if (String(process.env.DS_PEAK_DEBUG ?? '').trim()) console.error('[ds-statusline] HUD 抛错:', e?.stack ?? e);
  } finally {
    process.stdout.write = realWrite;
  }
  return chunks.join('');
}

/** 上一次成功画出来的帧（不带 key/TTL 校验），用于完整路径失败时兜底 */
function lastFrame() {
  try {
    const d = JSON.parse(readFileSync(FRAME_CACHE, 'utf8'));
    return typeof d.frame === 'string' ? d : null;
  } catch { return null; }
}

/**
 * 拼接：钱那一段接在**第一行**末尾，峰谷与时钟接在**最后一行**末尾
 * （保持原来那个监控插件的版式：钱在第 1 行跟时长并列，峰谷在 tools 那行）。
 */
function compose(frame, money, peak) {
  const lines = String(frame ?? '').split('\n');
  const idx = [];
  for (let i = 0; i < lines.length; i += 1) if (lines[i].trim() !== '') idx.push(i);
  if (idx.length === 0) {
    const bits = [money, peak].filter(Boolean);
    return bits.length ? `${bits.join(' | ')}\n` : '';
  }
  const first = idx[0];
  const last = idx[idx.length - 1];
  if (money) lines[first] = lines[first] ? `${lines[first]} | ${money}` : money;
  if (peak) lines[last] = lines[last] ? `${lines[last]} | ${peak}` : peak;
  return lines.join('\n');
}

let frame = null;
let lang = 'en';
let account = null;

const key = frameKey();
const cached = readFrame(key);
if (cached) {
  frame = cached.frame;
  lang = cached.lang ?? 'en';
  account = DS.readAccount();
} else {
  // 完整路径才 import HUD（模块图约 55ms），便宜路径完全不碰它
  const hud = await import(pathToFileURL(join(VENDOR, 'index.js')).href);
  const { loadConfig } = await import(pathToFileURL(join(VENDOR, 'config.js')).href);
  // 先拿上游规范化过的配置，再按 DeepSeek 的实际情况改几处
  let config = null;
  try { config = await loadConfig(); } catch { config = null; }
  if (config) {
    // 关掉上游的费用/用量：它按 Anthropic 价格与 Anthropic 的额度接口算，对 DeepSeek 是错的
    config.display = { ...config.display, showCost: false, showRoutedCost: false, showUsage: false };
    lang = config.language ?? 'en';
  }
  frame = config ? await runHud(hud, config) : '';
  account = await DS.refreshAccount({ transcriptPath: DS.transcriptFrom(stdin) });
  if (frame && config) {
    try {
      writeFileSync(FRAME_CACHE, JSON.stringify({ t: Date.now(), key, lang, frame }));
    } catch { /* 缓存写不了不影响渲染 */ }
  } else {
    // 完整路径没画出帧（配置坏了 / HUD 抛错）→ 退回上次的帧，别让状态栏只剩我们那一段；
    // 一次都没成功过就退回空帧（帧为空时 compose() 只会输出我们这段）
    const prev = lastFrame();
    if (prev) { frame = prev.frame; lang = prev.lang ?? lang; }
  }
}

const money = showPeak ? DS.moneySegment(account, lang) : '';
const peak = showPeak ? DS.peakSegment(lang) : '';
const out = compose(frame, money, peak);
if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
