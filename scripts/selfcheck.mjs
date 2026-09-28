#!/usr/bin/env node
/**
 * 自检 —— 不联网、不依赖你的会话，验证这份仓库在当前机器上是好的。
 *
 *   node scripts/selfcheck.mjs          跑全部
 *   node scripts/selfcheck.mjs --verbose 打印每条断言
 *
 * 覆盖：峰谷边界的判定、官方口径的算钱、内嵌上游是否齐、状态栏入口能不能真的画出东西。
 * 改动 peak-hours.cjs 的价/节假日表、或升级 vendor 之后，跑一下它。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PEAK = require(join(ROOT, 'scripts', 'peak-hours.cjs'));
const DS = require(join(ROOT, 'scripts', 'ds-usage.cjs'));

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
const failures = [];

function record(name, detail) {
  pass += 1;
  if (VERBOSE) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, e) {
  failures.push(`${name}: ${e.message}`);
  console.log(`  ✗ ${name} — ${e.message}`);
}
function check(name, fn) {
  try { record(name, fn()); } catch (e) { fail(name, e); }
}
// 异步检查：抓取是 async 的，同步的 check 接不住 Promise。收集起来在汇总前 await。
const asyncChecks = [];
function checkAsync(name, fn) { asyncChecks.push([name, fn]); }

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} 期望 ${b}，实际 ${a}`);
  return `${what} = ${a}`;
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}
/** 跑子进程并**容忍非零退出**（ds.mjs --balance 在 auth 失败时故意 exit 1），只要 stdout */
function run(file, args, opts = {}) {
  try {
    return execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', ...opts });
  } catch (e) {
    if (typeof e.stdout === 'string') return e.stdout;
    throw e;
  }
}
/** 一次性临时目录，用完必删。注入配置目录用 —— 不碰开发者真实的 ~/.claude */
function scratch(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-selfcheck-'));
  for (const [rel, data] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

console.log(`\nselfcheck · ${ROOT}\n`);

// ── 1. 峰谷判定（官方规则：北京时 周一至周五 09-12 / 14-18，排除法定节假日）──
console.log('峰谷判定');
const peakCases = [
  ['2026-09-27T04:00:00Z', false, '周日 12:00 北京 → 空闲'],
  ['2026-09-28T00:59:00Z', false, '周一 08:59 → 空闲'],
  ['2026-09-28T01:00:00Z', true, '周一 09:00 → 高峰'],
  ['2026-09-28T03:59:00Z', true, '周一 11:59 → 高峰'],
  ['2026-09-28T04:00:00Z', false, '周一 12:00 → 空闲'],
  ['2026-09-28T06:00:00Z', true, '周一 14:00 → 高峰'],
  ['2026-09-28T10:00:00Z', false, '周一 18:00 → 空闲'],
  ['2026-10-01T02:00:00Z', false, '国庆（周四）→ 空闲'],
  ['2026-10-08T01:00:00Z', true, '国庆后周四 09:00 → 高峰'],
  ['2026-02-14T02:00:00Z', false, '春节调休上班的周六 → 仍空闲'],
  ['2026-02-20T02:00:00Z', false, '春节假期内的周五 → 空闲'],
];
for (const [iso, expected, what] of peakCases) {
  check(what, () => eq(PEAK.isPeak(Date.parse(iso)), expected));
}
check('倒计时取到分界点', () => {
  const next = PEAK.nextChange(Date.parse('2026-09-28T00:59:00Z'));
  eq(new Date(next.t).toISOString(), '2026-09-28T01:00:00.000Z', '下次切换');
  return PEAK.fmtDurSec(next.t - Date.parse('2026-09-28T00:59:00Z'));
});
check('缺节假日表的年份带 ?', () => {
  ok(PEAK.peakBadge(Date.parse('2027-01-04T02:00:00Z'), 'zh').includes('?'), '2027 年应带 ?');
  ok(!PEAK.peakBadge(Date.parse('2026-09-28T02:00:00Z'), 'zh').includes('?'), '2026 年不该带 ?');
  return PEAK.peakBadge(Date.parse('2026-09-28T02:00:00Z'), 'zh');
});
check('时钟是北京时间 24 小时制', () => eq(PEAK.bjClock(Date.parse('2026-09-28T02:34:56Z')), '10:34:56'));

// ── 2. 官方口径算钱 ──
console.log('官方价计费');
check('flash 高峰：未命中 2 / 命中 0.04 / 输出 8（元每百万）', () => {
  const bucket = { inputTokens: 1e6, cacheCreationTokens: 0, cacheReadTokens: 1e6, outputTokens: 1e6 };
  const cost = PEAK.costFromBucket(bucket, 'flash', 0);
  return eq(Number(cost.toFixed(4)), 10.04, '高峰价');
});
check('flash 空闲价正好是高峰的一半', () => {
  const bucket = { inputTokens: 1e6, cacheCreationTokens: 0, cacheReadTokens: 1e6, outputTokens: 1e6 };
  const p = PEAK.costFromBucket(bucket, 'flash', 0);
  const o = PEAK.costFromBucket(bucket, 'flash', 1);
  return eq(Number((p / o).toFixed(6)), 2, '高峰/空闲倍率');
});
check('v4-pro 走另一张表', () => eq(PEAK.pickModel('deepseek-v4-pro'), 'pro'));
check('缓存写入算未命中', () => {
  const a = PEAK.costFromBucket({ inputTokens: 0, cacheCreationTokens: 1e6, cacheReadTokens: 0, outputTokens: 0 }, 'flash', 0);
  return eq(a, 2, '1M cache_creation 按未命中计');
});
check('峰谷两桶合计', () => {
  const buckets = {
    peak: { inputTokens: 1e6, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    offPeak: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 1e6 },
  };
  const c = PEAK.costFromBuckets(buckets, 'flash', Date.now());
  return eq([c.peak, c.offPeak, c.total], [2, 4, 6], '高峰/空闲/合计');
});

// ── 3. 内嵌上游 ──
console.log('内嵌上游');
for (const f of ['vendor/claude-hud/dist/index.js', 'vendor/claude-hud/dist/config.js', 'vendor/claude-hud/LICENSE', 'vendor/claude-hud/VENDORED.md']) {
  check(`存在 ${f}`, () => ok(existsSync(join(ROOT, f)), '缺少文件（跑 node tools/vendor-upstream.mjs）'));
}
check('上游 LICENSE 是 MIT 且写明版权人', () => {
  const t = readFileSync(join(ROOT, 'vendor', 'claude-hud', 'LICENSE'), 'utf8');
  ok(/MIT License/i.test(t), '不是 MIT');
  ok(/Copyright \(c\) 2026 Jarrod Watts/.test(t), '版权行不对');
  return 'MIT, Copyright (c) 2026 Jarrod Watts';
});
check('我们没有改上游文件', () => {
  const vendored = readFileSync(join(ROOT, 'vendor', 'claude-hud', 'VENDORED.md'), 'utf8');
  ok(/没有改动/.test(vendored), 'VENDORED.md 缺少"没有改动"说明');
});

// ── 3.5 默认配置示例（安装器会在配置不存在时原样写入它）──
console.log('默认配置示例');
check('examples/claude-hud.config.json 存在且是想要的那份', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'examples', 'claude-hud.config.json'), 'utf8'));
  eq(cfg.lineLayout, 'compact', 'lineLayout');
  eq(cfg.display.showTools, true, 'showTools');
  eq(cfg.display.showCost, false, 'showCost（费用由我们接管）');
  eq(cfg.display.showUsage, false, 'showUsage（DeepSeek 没有额度接口）');
  ok(Array.isArray(cfg.elementOrder) && !cfg.elementOrder.includes('deepseek'), 'elementOrder 不该再引用 fork 的 deepseek 元素');
  return 'compact + 工具行，且不引用上游不认识的元素';
});

// ── 3.6 余额密钥与失败兜底 ──
// 全部离线：注入配置目录/环境/传输/时钟。为什么不直接 require 后改环境就完事 ——
// CLAUDE_DIR 在 ds-usage.cjs 的 require 时就被烤死了，而本文件第 20 行已经 require 过它，
// 所以父进程里改不动，凡是跟配置目录有关的都只能靠**参数注入**；只有真要跑子进程的两条才 spawn。
console.log('余额密钥与失败兜底');

check('密钥来源优先级：settings.local.json 排在 settings.json 前', () => {
  const base = 'sk-' + 'b'.repeat(32);
  const local = 'sk-' + 'l'.repeat(32);
  const s = scratch({
    'settings.json': { env: { ANTHROPIC_AUTH_TOKEN: base } },
    'settings.local.json': { env: { ANTHROPIC_AUTH_TOKEN: local } },
  });
  try {
    // 注意语义：resolveApiKeys 是"列出全部候选、按优先级逐个试"，不是"local 替换 base"。
    // 所以两把不同的 key 就该都在，只是 local 必须排在前面。
    const got = DS.resolveApiKeys({ claudeDir: s.dir, env: {}, cwd: s.dir, managed: null });
    eq(got.length, 2, '两把不同的 key 都该是候选');
    eq(got[0].key, local, 'local 该排第一');
    ok(/settings\.local\.json$/.test(got[0].source), `首位该是 local，实际 ${got[0].source}`);
    ok(/settings\.json$/.test(got[1].source), `次位该是 base，实际 ${got[1].source}`);
    return got.map((g) => g.source).join(' → ');
  } finally { s.cleanup(); }
});

check('密钥来源：项目级 ./.claude/settings.json 也算', () => {
  const K = 'sk-' + 'p'.repeat(32);
  const s = scratch({ '.claude/settings.json': { env: { ANTHROPIC_AUTH_TOKEN: K } } });
  try {
    const got = DS.resolveApiKeys({ claudeDir: join(s.dir, 'nohome'), env: {}, cwd: s.dir, managed: null });
    eq(got.length, 1, '候选数');
    eq(got[0].key, K, '项目级密钥');
    return got[0].source;
  } finally { s.cleanup(); }
});

check('同一把 key 出现在多处 → 一个候选，但记住全部来源', () => {
  const K = 'sk-' + 'x'.repeat(32);
  const s = scratch({ 'settings.json': { env: { ANTHROPIC_AUTH_TOKEN: K } } });
  try {
    const got = DS.resolveApiKeys({ claudeDir: s.dir, env: { ANTHROPIC_AUTH_TOKEN: K }, cwd: s.dir, managed: null });
    eq(got.length, 1, '候选数（去重后）');
    eq(got[0].sources.length, 2, '来源数');
    return got[0].sources.join(' + ');
  } finally { s.cleanup(); }
});

check('打码：露出 ≤ 10 字符，短密钥全遮', () => {
  const K = 'sk-' + 'a'.repeat(32);
  const m = DS.maskKey(K);
  ok(!m.includes(K), '打码结果里含完整密钥');
  ok(m.replace('…', '').length <= 10, `露出太多: ${m}`);
  eq(DS.maskKey('short'), '…', '短密钥该全遮');
  eq(DS.maskKey(''), '', '空值');
  return m;
});

check('没有候选 → 判 nokey 且不派发进程', () => {
  const p = DS.planBalanceFetch({ keys: [], record: null, now: 1e12 });
  eq(p.spawn, false, 'spawn');
  eq(p.reason.code, 'nokey', '原因码');
  ok(p.reason.retryAt === Infinity, 'retryAt 该是 Infinity（永不自动重试）');
  return DS.reasonText(p.reason, 'zh-Hans');
});

check('401 硬退避 6 小时；换 key 后立刻重试（指纹逃逸）', () => {
  const now = 1e12;
  const rec = DS.normalizeBalanceRecord({ ok: false, code: 'auth', status: 401, at: now, keyFp: DS.keyFingerprint('old'), retryAt: now + 6 * 3600e3 });
  eq(DS.planBalanceFetch({ keys: [{ key: 'old' }], record: rec, now }).spawn, false, '同一个 key 该退避');
  eq(DS.planBalanceFetch({ keys: [{ key: 'new' }], record: rec, now }).spawn, true, '换了 key 该立刻重试');
  return 'auth → 6h，但换 key 即失效';
});

check('派发节奏：net 退避 30 秒、成功值 TTL 60 秒', () => {
  const now = 1e12;
  const K = DS.keyFingerprint('k');
  const net = DS.normalizeBalanceRecord({ ok: false, code: 'net', status: 0, at: now, keyFp: K, retryAt: now + 30e3 });
  eq(DS.planBalanceFetch({ keys: [{ key: 'k' }], record: net, now }).spawn, false, '退避内不该派');
  eq(DS.planBalanceFetch({ keys: [{ key: 'k' }], record: net, now: now + 31e3 }).spawn, true, '退避后该派');
  const good = DS.normalizeBalanceRecord({ total: 1, at: now });
  eq(DS.planBalanceFetch({ keys: [{ key: 'k' }], record: good, now }).spawn, false, '值新鲜不该派');
  eq(DS.planBalanceFetch({ keys: [{ key: 'k' }], record: good, now: now + 61e3 }).spawn, true, '值过期该派');
  return 'net 30s / 值 60s';
});

check('理由退避表：429 给 5 分钟，parse 给 30 分钟', () => {
  eq(DS.reasonBackoffMs('http', 429), 5 * 60e3, '429');
  eq(DS.reasonBackoffMs('http', 500), 60e3, '5xx');
  eq(DS.reasonBackoffMs('parse', 200), 30 * 60e3, 'parse');
  eq(DS.reasonBackoffMs('net', 0), 30e3, 'net');
  return '429→5min / 5xx→60s / parse→30min / net→30s';
});

check('余额为 0 是成功，不是 n/a；200 空体是异常（不能伪装成 ¥0）', () => {
  eq(DS.parseBalanceBody('{"is_available":true,"balance_infos":[{"total_balance":"0"}]}')?.total, 0, '真·零余额');
  eq(DS.parseBalanceBody('{}'), null, '空体该判失败（旧版会当成 ¥0.00 的成功值）');
  eq(DS.parseBalanceBody('not json'), null, '非 JSON');
  eq(DS.parseBalanceBody('{"balance_infos":[]}'), null, '空数组');
  const out = strip(DS.moneySegment({ cost: { total: 3.1 }, balance: { total: 0, at: Date.now() - 5000 } }, 'zh-Hans'));
  ok(out.includes('¥0.00'), `零余额该显示 ¥0.00：${out}`);
  ok(!out.includes('n/a'), '零余额不该显示 n/a');
  return '零余额显示 ¥0.00';
});

check('成功路径渲染不变（含余额、不含 n/a）', () => {
  const at = Date.now() - 12000;
  const out = strip(DS.moneySegment({ cost: { total: 3.1 }, balance: { total: 6.96, at } }, 'zh-Hans'));
  const age = Math.max(0, Math.round((Date.now() - at) / 1000));
  eq(out, `费用 ¥3.10  余额 ¥6.96 ${age}s  v${DS.version()}`, '渲染');
  ok(!out.includes('n/a'), '成功路径不该出现 n/a');
  return out;
});

check('四种失败文案（无key / 401 / 网络 / 异常）', () => {
  const V = DS.version();
  const m = (st) => strip(DS.moneySegment({ cost: { total: 3.1 }, balanceStatus: st }, 'zh-Hans'));
  eq(m({ code: 'nokey' }), `费用 ¥3.10  余额 n/a(无key)  v${V}`, '无key');
  eq(m({ code: 'auth', status: 401 }), `费用 ¥3.10  余额 n/a(401)  v${V}`, '401');
  eq(m({ code: 'auth', status: 403 }), `费用 ¥3.10  余额 n/a(401)  v${V}`, '403 归并成 401');
  eq(m({ code: 'net' }), `费用 ¥3.10  余额 n/a(网络)  v${V}`, '网络');
  eq(m({ code: 'parse' }), `费用 ¥3.10  余额 n/a(异常)  v${V}`, '异常');
  eq(strip(DS.moneySegment({ cost: { total: 3.1 }, balanceStatus: { code: 'net' } }, 'en')), `cost ¥3.10  bal n/a(network)  v${V}`, 'en');
  return '无key/401/网络/异常 + en';
});

check('有上次的好值时显示真值（哪怕当前是 401），不显示 n/a', () => {
  const out = strip(DS.moneySegment({ cost: { total: 3.1 }, balance: { total: 6.96, at: Date.now() - 200000 }, balanceStatus: null }, 'zh-Hans'));
  ok(out.includes('¥6.96'), `该显示上次的好值：${out}`);
  ok(out.includes('⚠'), '陈旧该带 ⚠');
  ok(!out.includes('n/a'), '有真值就不该显示 n/a');
  return out;
});

check('旧缓存格式不崩也不误判', () => {
  const s = scratch({
    'old-fail.json': { error: true, at: 1e12 },
    'old-ok.json': { total: 5, topped: 5, granted: 0, available: true, at: 1e12 },
  });
  try {
    const f = join(s.dir, 'old-fail.json');
    const o = join(s.dir, 'old-ok.json');
    eq(DS.readBalanceCache(f), null, '旧失败标记不该被当成余额值');
    eq(DS.readBalanceStatus(f).code, 'unknown', '旧失败标记的原因码');
    eq(DS.readBalanceCache(o)?.total, 5, '旧成功格式该照读');
    eq(DS.readBalanceStatus(o), null, '成功时不该有失败原因');
    return 'error:true → unknown；旧成功格式照读';
  } finally { s.cleanup(); }
});

check('base URL 判定：deepseek 官方 vs 中转站', () => {
  const a = DS.resolveBaseUrl({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, claudeDir: '/nonexistent', managed: null });
  ok(a.isDeepSeek && a.host === 'api.deepseek.com', `官方端点判定失败: ${JSON.stringify(a)}`);
  const b = DS.resolveBaseUrl({ env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1' }, claudeDir: '/nonexistent', managed: null });
  ok(!b.isDeepSeek, '中转站不该判成 deepseek');
  ok(DS.resolveBaseUrl({ env: {}, claudeDir: '/nonexistent', managed: null }).raw === '', '没设时该是空');
  return 'deepseek ✓ / relay ⚠';
});

check('诊断提示覆盖朋友那种情形（中转站 + 401）', () => {
  const h = DS.hintFor({
    reason: { code: 'auth', status: 401, source: '~/.claude/settings.json' },
    base: { raw: 'https://relay.example/v1', host: 'relay.example', isDeepSeek: false },
    sources: [{ state: 'present', looksLike: 'deepseek' }],
  });
  ok(!!h, '该给出提示');
  ok(/中转站/.test(h.zh), `zh 提示该提到中转站: ${h.zh}`);
  ok(/relay\.example/.test(h.zh), 'zh 提示该点名 host');
  ok(/~\/\.claude\/settings\.json/.test(h.zh), 'zh 提示该点名实际用的那份密钥来源');
  ok(/platform\.deepseek\.com/.test(h.en), 'en 提示该给出修法');
  ok(!!DS.hintFor({ reason: { code: 'nokey' }, base: { raw: 'https://api.deepseek.com' }, sources: [] }), 'nokey 该有提示');
  return '点名 host + 来源 + 修法';
});

// 注入传输：离线模拟 200 / 401 / 网络错，不碰网络
const OK_BODY = '{"is_available":true,"balance_infos":[{"total_balance":"6.96","topped_up_balance":"6.96","granted_balance":"0"}]}';
const reply = (status, body) => () => Promise.resolve({ status, body });

checkAsync('注入传输：200 解出值 + 来源 + 指纹', async () => {
  const r = await DS.fetchBalance(1000, { keys: [{ key: 'k1', source: 'src-1' }], request: reply(200, OK_BODY) });
  eq(r.ok, true, 'ok');
  eq(r.total, 6.96, 'total');
  eq(r.source, 'src-1', 'source');
  eq(r.keyFp, DS.keyFingerprint('k1'), 'keyFp');
  eq(r.attempts.length, 1, '尝试次数');
  return `¥${r.total} ← ${r.source}`;
});

checkAsync('注入传输：401 → auth，退避 6 小时', async () => {
  const r = await DS.fetchBalance(1000, { keys: [{ key: 'k1', source: 's' }], request: reply(401, '{}') });
  eq(r.ok, false, 'ok');
  eq(r.code, 'auth', '原因码');
  eq(r.status, 401, '状态码');
  eq(r.retryAt - r.at, 6 * 3600e3, '退避');
  return 'auth 401 → 6h';
});

checkAsync('注入传输：网络错只试一个候选（换 key 没用）', async () => {
  const keys = [{ key: 'k1', source: 's1' }, { key: 'k2', source: 's2' }];
  const r = await DS.fetchBalance(1000, { keys, request: reply(0, '') });
  eq(r.code, 'net', '原因码');
  eq(r.attempts.length, 1, '只该试一个');
  return 'net → 1 次尝试';
});

checkAsync('注入传输：5xx 也只试一个候选', async () => {
  const keys = [{ key: 'k1', source: 's1' }, { key: 'k2', source: 's2' }];
  const r = await DS.fetchBalance(1000, { keys, request: reply(500, 'x') });
  eq(r.code, 'http', '原因码');
  eq(r.status, 500, '状态码');
  eq(r.attempts.length, 1, '只该试一个');
  return 'http 500 → 1 次尝试';
});

checkAsync('注入传输：先 401 再 200 → 换到第二把成功', async () => {
  let n = 0;
  const request = () => Promise.resolve(n++ === 0 ? { status: 401, body: '{}' } : { status: 200, body: OK_BODY });
  const r = await DS.fetchBalance(1000, { keys: [{ key: 'k1', source: 's1' }, { key: 'k2', source: 's2' }], request });
  eq(r.ok, true, 'ok');
  eq(r.source, 's2', '该落到第二把');
  eq(r.attempts.map((a) => a.status), [401, 200], '两次尝试');
  return '401 → 200，落到 s2';
});

checkAsync('注入传输：200 空体 → parse（不是假 ¥0）', async () => {
  const r = await DS.fetchBalance(1000, { keys: [{ key: 'k1', source: 's' }], request: reply(200, '{}') });
  eq(r.ok, false, 'ok');
  eq(r.code, 'parse', '原因码');
  return 'parse 不是 ¥0';
});

checkAsync('端到端：没有 key 时状态栏吐出 n/a(无key)', async () => {
  const s = scratch({ 'settings.json': { env: {} } });
  try {
    const sample = execFileSync(process.execPath, [join(ROOT, 'tools', 'make-sample-stdin.mjs'), '--transcript', join(ROOT, 'nope.jsonl')], { encoding: 'utf8' });
    const env = {
      ...process.env, CLAUDE_CONFIG_DIR: s.dir, DS_CACHE_DIR: join(s.dir, 'cache'),
      DEEPSEEK_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '',
    };
    const out = strip(run(join(ROOT, 'scripts', 'statusline.mjs'), [], { input: sample, cwd: s.dir, env }));
    ok(/余额 n\/a\(无key\)|bal n\/a\(no-key\)/.test(out), `输出里没有兜底段: ${JSON.stringify(out.slice(-200))}`);
    return out.trim().split('\n').pop().slice(-50);
  } finally { s.cleanup(); }
});

checkAsync('端到端：--balance 不打印完整密钥', async () => {
  const fake = 'sk-' + 'deadbeef'.repeat(4);
  const out = strip(run(join(ROOT, 'scripts', 'ds.mjs'), ['--balance', '--cached', '--zh'], { env: { ...process.env, DEEPSEEK_API_KEY: fake } }));
  ok(!out.includes(fake), '--balance 泄露了完整密钥');
  ok(out.includes('sk-dea…beef'), `没有显示打码后的密钥: ${out.slice(0, 200)}`);
  ok(/deepseek/.test(out), '没有显示 base URL 判定');
  return '打码为 sk-dea…beef';
});

// 跑完本组的异步检查，这样它们打印在上面那个组标题之下
for (const [name, fn] of asyncChecks) {
  try { record(name, await fn()); } catch (e) { fail(name, e); }
}

// ── 4. 状态栏入口真的能画 ──
console.log('状态栏入口');
const sample = execFileSync(process.execPath, [join(ROOT, 'tools', 'make-sample-stdin.mjs'), '--transcript', join(ROOT, 'nope.jsonl')], { encoding: 'utf8' });
check('入口能输出峰谷段与时钟', () => {
  rmSync(join(ROOT, 'cache', 'frame.json'), { force: true });
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'statusline.mjs')], { input: sample, encoding: 'utf8' });
  ok(/DS(峰|谷|peak|off)/.test(out), `输出里没有峰谷段: ${JSON.stringify(out.slice(0, 120))}`);
  ok(/\d{2}:\d{2}:\d{2}/.test(out), '输出里没有时钟');
  return out.trim().split('\n').pop().slice(0, 90);
});
check('空 stdin 时静默退出（Claude Code 校验设置时会这样调）', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'statusline.mjs')], { input: '', encoding: 'utf8' });
  return eq(out, '', '输出');
});
check('安装器 dry-run 能跑，并交代 HUD 配置怎么处理', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dry-run'], { encoding: 'utf8' });
  ok(/statusLine/.test(out), 'dry-run 输出里没有 statusLine');
  ok(/HUD 配置/.test(out), 'dry-run 输出里没说 HUD 配置是写还是保留');
  return /已有 HUD 配置/.test(out) ? '本机已有配置 → 保留' : '本机无配置 → 会写一份默认';
});
// 回归测试：安装目录里若不写 package.json，内嵌 HUD 的 .js 就不被当作 ESM，
// 老一点的 Node（没有模块语法自动探测）上状态栏整排空白且不报错。见 install.mjs 的注释。
check('安装副本自带 package.json，且在没有模块自动探测的 Node 上仍能渲染', () => {
  const s = scratch();
  try {
    execFileSync(process.execPath, [join(ROOT, 'install.mjs'), '--dest', s.dir, '--no-statusline', '--no-config'], { encoding: 'utf8' });
    const pkg = JSON.parse(readFileSync(join(s.dir, 'package.json'), 'utf8'));
    eq(pkg.type, 'module', '安装目录 package.json 的 type');
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) return 'type=module（Node <22 本就没有自动探测，结构检查即已覆盖）';
    const out = execFileSync(
      process.execPath,
      ['--no-experimental-detect-module', join(s.dir, 'scripts', 'statusline.mjs')],
      { input: sample, encoding: 'utf8', env: { ...process.env, DS_CACHE_DIR: s.dir } },
    );
    ok(strip(out).trim().length > 0, '模拟老 Node 时安装副本渲染为空 —— package.json 大概没被写进去');
    return 'type=module；模拟老 Node 条件下渲染非空';
  } finally {
    s.cleanup();
  }
});

// ── 汇总 ──
console.log('');
if (failures.length) {
  console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ 全部通过（${pass} 项）`);
