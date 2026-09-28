#!/usr/bin/env node
/**
 * 命令行大盘 / 峰谷查询 / 余额诊断（零依赖）
 *
 *   node scripts/ds.mjs              本会话费用、余额、token、缓存命中率、当前档费率（盒子）
 *   node scripts/ds.mjs --peak       只看峰谷 + 当前北京时间 + 当档价（/ds-peak 用）
 *   node scripts/ds.mjs --short      一行
 *   node scripts/ds.mjs --json       机器可读
 *   node scripts/ds.mjs --refresh    强制重扫转录并同步抓一次余额
 *   node scripts/ds.mjs --balance    余额诊断：密钥来源逐条列出、base URL 判定、本次尝试、退避
 *   node scripts/ds.mjs --balance --cached   同上但不下网（只看已有记录）
 *   node scripts/ds.mjs --transcript <path.jsonl>   指定会话（默认取最新的）
 *
 * 旗标优先级：--balance > --json > --short > --peak。--balance 可叠加 --json 出机器可读的诊断。
 *
 * 计费口径：官方人民币价，分高峰/空闲；输入分缓存命中/未命中。规则见 scripts/peak-hours.cjs。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEAK = require(path.join(HERE, 'peak-hours.cjs'));
const DS = require(path.join(HERE, 'ds-usage.cjs'));

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', bcyan: '\x1b[96m', byellow: '\x1b[93m',
};

// ── 盒子辅助 ──（提到前面，因为 --balance 只读分支要在 refreshAccount 之前跑）
const W = 58;
const HR = '═'.repeat(W), HR2 = '─'.repeat(W);
const row = (inner = '') => `  ${C.bcyan}${C.bold}║${C.reset}${inner}${' '.repeat(Math.max(0, W - vis(inner)))}${C.bcyan}${C.bold}║${C.reset}`;
const bar = (pct, w = 14) => {
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  const color = pct >= 80 ? C.green : pct >= 40 ? C.yellow : C.red;
  return color + '█'.repeat(filled) + C.dim + '░'.repeat(w - filled) + C.reset;
};
const cny = (n) => (n < 0.1 ? n.toFixed(3) : n.toFixed(2));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (argv.indexOf(f) !== -1 ? argv[argv.indexOf(f) + 1] : null);

// 语言跟状态栏保持一致：读内嵌 HUD 的配置（没有就按上游默认 en），--zh / --en 可强制
async function resolveLang() {
  if (has('--zh')) return 'zh';
  if (has('--en')) return 'en';
  try {
    const { loadConfig } = await import(new URL('../vendor/claude-hud/dist/config.js', import.meta.url));
    const cfg = await loadConfig();
    return cfg?.language ?? 'en';
  } catch { return 'en'; }
}
const lang = await resolveLang();
const zh = String(lang).toLowerCase().startsWith('zh');

// 视觉宽度：去掉 ANSI，CJK/全角/emoji 记 2 格
function vis(s) {
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  let n = 0;
  for (const ch of plain) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf);
    n += wide ? 2 : 1;
  }
  return n;
}

// ── 余额诊断（**只读**：不派后台进程、不写任何缓存）──
if (has('--balance')) {
  const probe = has('--cached') ? null : await DS.fetchBalance(5000);
  const record = DS.readBalanceRecord();
  const verdict = probe ?? record;
  const sources = DS.listKeySources();
  const base = DS.resolveBaseUrl();
  const hint = DS.hintFor({ reason: verdict && !verdict.ok ? verdict : null, base, sources, source: verdict?.source });
  const ts = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE').replace('T', ' ') : '?');  // sv-SE 恰好近似 ISO
  const okAll = verdict?.ok === true;
  const headline = okAll
    ? `${C.green}${C.bold}✅ 余额 ¥${verdict.total.toFixed(2)}${C.reset}`
    : verdict
      ? `${C.red}${C.bold}❌ n/a(${DS.reasonText(verdict, lang)})${C.reset}${C.dim} — ${verdict.code}${verdict.status ? ` ${verdict.status}` : ''}${C.reset}`
      : `${C.dim}${zh ? '(还没有任何记录)' : '(no record yet)'}${C.reset}`;

  if (has('--json')) {
    process.stdout.write(JSON.stringify({
      verdict: verdict ?? null, probe, record, base, sources,
      hint: hint ? hint[zh ? 'zh' : 'en'] : null,
    }, null, 2) + '\n');
    process.exit(verdict && !verdict.ok && verdict.code === 'auth' ? 1 : 0);
  }

  const lines = [];
  lines.push(`  ${C.bcyan}${C.bold}╔${HR}╗${C.reset}`);
  lines.push(row(`  ${C.bold}${C.cyan}🔑 DeepSeek ${zh ? '余额诊断' : 'balance doctor'}${C.reset}${C.dim} · ${has('--cached') ? (zh ? '离线' : 'offline') : (zh ? '已探测' : 'probed')}${C.reset}`));
  lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
  lines.push(row(`  ${C.dim}${zh ? '结论' : 'verdict'}${C.reset}  ${headline}`));
  lines.push(row(`  ${C.dim}base${C.reset}  ${base.raw ? `${base.host}` : `${C.dim}${zh ? '未设置' : 'unset'}${C.reset}`}${base.isDeepSeek ? ` ${C.green}✓ deepseek${C.reset}` : ` ${C.yellow}⚠ ${zh ? '非 DeepSeek' : 'not deepseek'}${C.reset}`}`));
  lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
  lines.push(row(`  ${C.dim}${zh ? '密钥来源（按优先级，值已打码）' : 'key sources (priority order, masked)'}${C.reset}`));
  for (const s of sources) {
    // 具体是哪个字段（ANTHROPIC_AUTH_TOKEN 还是 API_KEY）放在 --json 里，不进盒子 —— 会撑破边框
    const state = s.state === 'present'
      ? `${C.green}${s.value}${C.reset}`
      : s.state === 'missing'
        ? `${C.dim}${zh ? '不存在' : 'missing'}${C.reset}`
        : `${C.dim}${zh ? '空' : 'empty'}${C.reset}`;
    const dup = s.dupOf ? ` ${C.dim}${zh ? `同 ${s.dupOf}` : `dup ${s.dupOf}`}${C.reset}` : '';
    lines.push(row(`  ${C.dim}${s.label}${C.reset} ${state}${dup}`));
  }
  if (verdict?.keyFp) lines.push(row(`  ${C.dim}${zh ? 'key 指纹' : 'key fp'} ${verdict.keyFp}${zh ? '（跨机器比对用，不可逆）' : ' (compare across machines)'}${C.reset}`));
  lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
  const att = (probe ?? record)?.attempts ?? [];
  lines.push(row(`  ${C.dim}${has('--cached') ? (zh ? '上次尝试' : 'last attempts') : (zh ? '本次尝试' : 'attempts')}${C.reset}`));
  if (att.length) {
    for (const a of att) {
      const bad = a.code !== 'ok';
      lines.push(row(`  ${bad ? C.red : C.green}${a.status || (zh ? '网络' : 'net')}${C.reset} ${C.dim}${a.code}${C.reset} ${C.dim}${a.source}${C.reset}`));
    }
  } else {
    lines.push(row(`  ${C.dim}${zh ? '（无）' : '(none)'}${C.reset}`));
  }
  if (record) {
    lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
    lines.push(row(`  ${C.dim}${zh ? '上次记录' : 'last record'}${C.reset} ${record.ok ? `¥${record.total.toFixed(2)}` : `n/a(${DS.reasonText(record, lang)})`} ${C.dim}${ts(record.at)}${C.reset}`));
    if (!record.ok && record.retryAt !== Infinity && record.retryAt > Date.now()) {
      const left = PEAK.fmtDurSec(record.retryAt - Date.now());
      lines.push(row(`  ${C.dim}${zh ? '退避到' : 'backoff to'}${C.reset} ${ts(record.retryAt)} ${C.dim}(${zh ? '还有' : 'in'} ${left})${C.reset}`));
    }
  }
  lines.push(`  ${C.bcyan}${C.bold}╚${HR}╝${C.reset}`);
  if (hint) lines.push(`  ${C.yellow}⚠️  ${hint[zh ? 'zh' : 'en']}${C.reset}`);
  lines.push(`  ${C.dim}${zh ? '（诊断是只读的：不派后台进程、不写缓存）' : '(read-only: no background spawn, no cache writes)'}${C.reset}`);
  console.log('\n' + lines.join('\n') + '\n');
  process.exit(verdict && !verdict.ok && verdict.code === 'auth' ? 1 : 0);
}

const total = await DS.refreshAccount({
  transcriptPath: val('--transcript') || undefined,
  force: has('--refresh'),
});
if (has('--refresh')) {
  // 同步抓一次并**落盘**，这样手动刷新之后状态栏也立刻收敛（不只是这一次输出好看）
  const rec = await DS.fetchBalance(5000);
  if (rec) {
    DS.writeBalanceRecord(rec);
    total.balance = DS.balanceValueOf(rec) ?? total.balance ?? null;
    total.balanceStatus = rec.ok ? null : rec;
  }
}

const cost = total?.cost ?? { total: 0, peak: 0, offPeak: 0 };
const tok = total?.tokens ?? { miss: 0, hit: 0, out: 0, totalIn: 0, ctxPeak: 0, calls: 0 };
const bal = total?.balance ?? null;
const balStatus = total?.balanceStatus ?? null;
const modelKey = total?.modelKey ?? 'flash';
const modelLabel = PEAK.MODEL_LABEL[modelKey];
const peakNow = PEAK.isPeak(Date.now());
const periodIdx = peakNow ? 0 : 1;
const rate = PEAK.RATES[modelKey];
const next = PEAK.nextChange(Date.now());

if (has('--json')) {
  process.stdout.write(JSON.stringify({
    peak: peakNow, beijing: PEAK.bjClock(Date.now()), nextChangeIn: next.t ? next.t - Date.now() : null,
    cost, tokens: tok, balance: bal, model: modelKey, rates: rate, periodIndex: periodIdx,
    rateNow: { hit: rate.hit[periodIdx], miss: rate.miss[periodIdx], out: rate.out[periodIdx] },
    // 加法式字段：balance 仍是 value|null（守房子规约），想区分"¥0"和"没取到"就看这个
    balanceStatus: total?.balanceStatus ?? null,
    session: total?.transcriptPath ?? null,
  }, null, 2) + '\n');
  process.exit(0);
}

const periodName = zh ? (peakNow ? '高峰' : '空闲') : (peakNow ? 'peak' : 'off-peak');
const periodIcon = peakNow ? '🔴' : '🟢';
const remain = next.t ? PEAK.fmtDurSec(next.t - Date.now()) : '?';

if (has('--short')) {
  // 注意：以前这里写的是 DS.attachSegment —— 那个函数不存在，跑 --short 会直接 TypeError。
  const bits = [DS.moneySegment(total, lang), DS.peakSegment(lang)].filter(Boolean);
  process.stdout.write(bits.join(' ') + '\n');
  process.exit(0);
}

if (has('--peak')) {
  const r = rate;
  const cny = (n) => (n < 0.1 ? n.toFixed(3) : n.toFixed(2));
  console.log('');
  console.log(`  ${C.bold}${C.cyan}DeepSeek ${zh ? '峰谷' : 'peak hours'}${C.reset}${C.dim}  ${zh ? '官方: 北京时间周一至周五(不含中国法定节假日) 09:00-12:00 · 14:00-18:00' : 'official: Mon-Fri (excl. CN holidays) 09:00-12:00 & 14:00-18:00 Beijing'}${C.reset}`);
  const badge = peakNow ? `${C.red}${C.bold}🔴 ${periodName}${C.reset}` : `${C.green}${C.bold}🟢 ${periodName}${C.reset}`;
  console.log(`  ${zh ? '当前' : 'now '}  ${badge}   ${C.bold}${PEAK.bjClock(Date.now())}${C.reset}${C.dim} ${zh ? '北京时间' : 'Beijing'}${C.reset}`);
  if (next.t) console.log(`  ${zh ? '下次' : 'next'}  ⏭  ${zh ? `转${next.peak ? '高峰' : '空闲'}` : `→ ${next.peak ? 'peak' : 'off-peak'}`} ${C.dim}· ${zh ? '还有' : 'in'} ${remain}${C.reset}`);
  if (!PEAK.hasHolidayData(Date.now())) console.log(`  ${C.yellow}⚠️  ${zh ? '本年节假日表未收录，节假日期间判定可能不准' : 'no holiday table for this year — holidays may be misjudged'}${C.reset}`);
  console.log('');
  console.log(`  ${C.dim}${zh ? '官方价 (元 / 百万 tokens)' : 'official rates (CNY / 1M tokens)'}${C.reset}`);
  console.log(`  ${C.bold}${modelLabel}${C.reset}`);
  console.log(`    ${C.dim}${zh ? '缓存命中' : 'cache hit'}${C.reset}    ${C.yellow}${cny(r.hit[0])}${C.reset} ${C.dim}/${C.reset} ${C.green}${cny(r.hit[1])}${C.reset}`);
  console.log(`    ${C.dim}${zh ? '缓存未命中' : 'cache miss'}${C.reset}  ${C.yellow}${cny(r.miss[0])}${C.reset} ${C.dim}/${C.reset} ${C.green}${cny(r.miss[1])}${C.reset}`);
  console.log(`    ${C.dim}${zh ? '输出' : 'output'}${C.reset}        ${C.yellow}${cny(r.out[0])}${C.reset} ${C.dim}/${C.reset} ${C.green}${cny(r.out[1])}${C.reset}`);
  console.log(`  ${C.dim}${zh ? '左高峰 / 右空闲；空闲价恒为高峰半价' : 'left = peak / right = off-peak (half price)'}${C.reset}`);
  console.log('');
  process.exit(0);
}

// ── 盒子大盘 ──
const balColor = !bal ? C.dim : bal.total <= 0.5 ? C.red : bal.total <= 5 ? C.yellow : C.green;
const sessionId = total?.transcriptPath ? path.basename(total.transcriptPath).replace(/\.jsonl$/, '') : '?';

const lines = [];
lines.push(`  ${C.bcyan}${C.bold}╔${HR}╗${C.reset}`);
lines.push(row(`  ${C.bold}${C.cyan}🔍 DeepSeek ${zh ? '用量' : 'usage'}${C.reset}${C.dim} · ${zh ? '官方口径' : 'official rates'}${C.reset}`));
lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
lines.push(row(`  ${C.bold}💰 ${zh ? '余额' : 'balance'}${C.reset}  ${bal ? `${bal.available ? C.green + '●' + C.reset : C.red + '●' + C.reset} ${C.bold}${balColor}¥${bal.total.toFixed(2)}${C.reset}` : balStatus ? `${C.red}n/a(${DS.reasonText(balStatus, lang)})${C.reset}` : `${C.dim}${zh ? '(未取到，后台重试中)' : '(unavailable, retrying in background)'}${C.reset}`}`));
lines.push(row(`  ${C.bold}💵 ${zh ? '本会话' : 'this session'}${C.reset}  ${C.byellow}${DS.fmtCost(cost.total)}${C.reset}  ${C.dim}(${zh ? '高峰' : 'peak'} ${DS.fmtCost(cost.peak)} / ${zh ? '空闲' : 'off'} ${DS.fmtCost(cost.offPeak)})${C.reset}`));
lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
lines.push(row(`  ${C.bold}📊 Token${C.reset}`));
lines.push(row(`  ${C.dim}${zh ? '上下文峰值' : 'context peak'}${C.reset} ${C.bold}${DS.fmtTokens(tok.ctxPeak)}${C.reset}   ${C.dim}${zh ? 'API 调用' : 'API calls'}${C.reset} ${C.magenta}${tok.calls}${C.reset}`));
lines.push(row(`  ${C.blue}📥 ${zh ? '未命中' : 'miss'}${C.reset} ${C.bold}${DS.fmtTokens(tok.miss)}${C.reset}   ${C.cyan}📥 ${zh ? '命中' : 'hit'}${C.reset} ${C.bold}${DS.fmtTokens(tok.hit)}${C.reset}`));
lines.push(row(`  ${C.magenta}📤 ${zh ? '输出' : 'out'}${C.reset}   ${C.bold}${DS.fmtTokens(tok.out)}${C.reset}   ${C.dim}${zh ? '缓存命中率' : 'cache hit rate'}${C.reset} ${bar(total?.cachePct ?? 0)} ${(total?.cachePct ?? 0).toFixed(1)}%`));
lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
lines.push(row(`  ${C.bold}💲 ${zh ? '当前计费' : 'current rate'}${C.reset}  ${periodIcon} ${C.bold}${periodName}${C.reset}${next.t ? `${C.dim} · ${zh ? '还有' : 'in'} ${remain}${C.reset}` : ''}`));
lines.push(row(`  ${C.dim}${modelLabel} (${zh ? '元' : 'CNY'} / 1M tokens)${C.reset}`));
lines.push(row(`  ${C.dim}${zh ? '未命中' : 'miss'}${C.reset} ${C.yellow}${cny(rate.miss[periodIdx])}${C.reset}   ${C.dim}${zh ? '命中' : 'hit'}${C.reset} ${C.yellow}${cny(rate.hit[periodIdx])}${C.reset}   ${C.dim}${zh ? '输出' : 'out'}${C.reset} ${C.yellow}${cny(rate.out[periodIdx])}${C.reset}`));
lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
lines.push(row(`  ${C.dim}📋 ${sessionId.slice(0, 30)}${C.reset}`));
lines.push(`  ${C.bcyan}${C.bold}╚${HR}╝${C.reset}`);
if (!PEAK.hasHolidayData(Date.now())) {
  lines.push(`  ${C.yellow}⚠️  ${zh ? '本年节假日表未收录，峰谷与费用可能不准' : 'no holiday table for this year — peak hours and cost may be off'}${C.reset}`);
}
if (balStatus) {
  const h = DS.hintFor({ reason: balStatus, base: DS.resolveBaseUrl(), sources: DS.listKeySources(), source: balStatus.source });
  if (h) lines.push(`  ${C.yellow}⚠️  ${h[zh ? 'zh' : 'en']}${C.reset}`);
  lines.push(`  ${C.dim}${zh ? '余额排障：node scripts/ds.mjs --balance' : 'balance doctor: node scripts/ds.mjs --balance'}${C.reset}`);
}
console.log('\n' + lines.join('\n') + '\n');
