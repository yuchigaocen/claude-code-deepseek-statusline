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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PEAK = require(join(ROOT, 'scripts', 'peak-hours.cjs'));
const DS = require(join(ROOT, 'scripts', 'ds-usage.cjs'));

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    pass += 1;
    if (VERBOSE) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} 期望 ${b}，实际 ${a}`);
  return `${what} = ${a}`;
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

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

// ── 汇总 ──
console.log('');
if (failures.length) {
  console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ 全部通过（${pass} 项）`);
