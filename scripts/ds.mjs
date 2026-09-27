#!/usr/bin/env node
/**
 * 命令行大盘 / 峰谷查询（零依赖）
 *
 *   node scripts/ds.js              本会话费用、余额、token、缓存命中率、当前档费率（盒子）
 *   node scripts/ds.js --peak       只看峰谷 + 当前北京时间 + 当档价（/ds-peak 用）
 *   node scripts/ds.js --short      一行
 *   node scripts/ds.js --json       机器可读
 *   node scripts/ds.js --refresh    强制重扫转录并同步抓一次余额
 *   node scripts/ds.js --transcript <path.jsonl>   指定会话（默认取最新的）
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

const total = await DS.refreshAccount({
  transcriptPath: val('--transcript') || undefined,
  force: has('--refresh'),
});
if (has('--refresh')) {
  const bal = await DS.fetchBalance(5000);
  if (bal) total.balance = bal;
}

const cost = total?.cost ?? { total: 0, peak: 0, offPeak: 0 };
const tok = total?.tokens ?? { miss: 0, hit: 0, out: 0, totalIn: 0, ctxPeak: 0, calls: 0 };
const bal = total?.balance ?? null;
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
    session: total?.transcriptPath ?? null,
  }, null, 2) + '\n');
  process.exit(0);
}

const periodName = zh ? (peakNow ? '高峰' : '空闲') : (peakNow ? 'peak' : 'off-peak');
const periodIcon = peakNow ? '🔴' : '🟢';
const remain = next.t ? PEAK.fmtDurSec(next.t - Date.now()) : '?';

if (has('--short')) {
  const bits = [DS.attachSegment(total, lang)];
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
const W = 58;
const HR = '═'.repeat(W), HR2 = '─'.repeat(W);
const row = (inner = '') => `  ${C.bcyan}${C.bold}║${C.reset}${inner}${' '.repeat(Math.max(0, W - vis(inner)))}${C.bcyan}${C.bold}║${C.reset}`;
const bar = (pct, w = 14) => {
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  const color = pct >= 80 ? C.green : pct >= 40 ? C.yellow : C.red;
  return color + '█'.repeat(filled) + C.dim + '░'.repeat(w - filled) + C.reset;
};
const cny = (n) => (n < 0.1 ? n.toFixed(3) : n.toFixed(2));

const balColor = !bal ? C.dim : bal.total <= 0.5 ? C.red : bal.total <= 5 ? C.yellow : C.green;
const sessionId = total?.transcriptPath ? path.basename(total.transcriptPath).replace(/\.jsonl$/, '') : '?';

const lines = [];
lines.push(`  ${C.bcyan}${C.bold}╔${HR}╗${C.reset}`);
lines.push(row(`  ${C.bold}${C.cyan}🔍 DeepSeek ${zh ? '用量' : 'usage'}${C.reset}${C.dim} · ${zh ? '官方口径' : 'official rates'}${C.reset}`));
lines.push(`  ${C.bcyan}${C.bold}╠${HR2}╣${C.reset}`);
lines.push(row(`  ${C.bold}💰 ${zh ? '余额' : 'balance'}${C.reset}  ${bal ? `${bal.available ? C.green + '●' + C.reset : C.red + '●' + C.reset} ${C.bold}${balColor}¥${bal.total.toFixed(2)}${C.reset}` : `${C.dim}${zh ? '(未取到，后台重试中)' : '(unavailable, retrying in background)'}${C.reset}`}`));
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
console.log('\n' + lines.join('\n') + '\n');
