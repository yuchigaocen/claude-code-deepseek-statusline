#!/usr/bin/env node
/**
 * 生成 README 用的预览图：docs/preview.png（英文）与 docs/preview.zh.png（中文）。
 *
 *   node tools/make-preview.mjs            生成两张图（需要本机有 Edge 或 Chrome）
 *   node tools/make-preview.mjs --keep-html 顺便留下中间 HTML，方便手改样式
 *
 * 做法：走**真实的渲染路径**拿到两行文本（内嵌 HUD 的整帧 + 我们那段），把 ANSI 颜色转成 HTML，
 * 再用无头浏览器截图。所以图里的内容与真机一致，不是画出来的。
 *
 * ⚠️ 图里的费用/余额是**构造的示例值**（¥3.10 / +¥0.0084 / ¥42.00），不是任何人的真实账户数据；
 * 峰谷状态与时钟是运行时算出来的真值。HUD 帧来自本机最新的会话转录，因此工具行是真实的。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DS = require(join(ROOT, 'scripts', 'ds-usage.cjs'));
const CACHE = join(ROOT, 'cache');
const DOCS = join(ROOT, 'docs');

// ── 1. 造一份"演示账户"，让费用/余额显示成示例值（不碰任何真实数据）──
const DEMO = {
  transcriptPath: null,
  costAt: Date.now(),
  cost: { total: 3.10, peak: 0.42, offPeak: 2.68 },
  tokens: { miss: 148900, hit: 43670000, out: 269700, totalIn: 43818900, ctxPeak: 253700, calls: 197 },
  modelKey: 'flash',
  modelId: 'deepseek-flash',
  cachePct: 99.7,
  delta: 0.0084,
  shownCost: 3.10,
  balance: { total: 42.00, topped: 42.00, granted: 0, available: true, at: Date.now() - 12_000 },
};
mkdirSync(CACHE, { recursive: true });
writeFileSync(join(CACHE, 'account.json'), JSON.stringify(DEMO));

// ── 2. 用演示载荷跑一次入口，拿到 HUD 的真实帧（工具行/上下文条/时长都来自本机最新会话）──
const payload = JSON.parse(execFileSync(process.execPath, [
  join(ROOT, 'tools', 'make-sample-stdin.mjs'),
  '--cwd', '~/projects/my-app',
  '--tokens', '253700',
], { encoding: 'utf8' }));
spawnSync(process.execPath, [join(ROOT, 'scripts', 'statusline.mjs')], { input: JSON.stringify(payload), encoding: 'utf8' });

let frame = '';
try { frame = JSON.parse(readFileSync(join(CACHE, 'frame.json'), 'utf8')).frame; } catch { /* ignore */ }
if (!frame) {
  console.error('拿不到 HUD 帧 —— 先手动跑一次: node scripts/statusline.mjs < sample.json');
  process.exit(1);
}

// ── 3. 按入口同样的位置规则拼两版文本：钱→第一行末尾，峰谷+时钟→最后一行末尾 ──
function compose(frameText, money, peak) {
  const lines = String(frameText).split('\n');
  const idx = [];
  for (let i = 0; i < lines.length; i += 1) if (lines[i].trim() !== '') idx.push(i);
  if (!idx.length) return `${[money, peak].filter(Boolean).join(' | ')}\n`;
  const first = idx[0];
  const last = idx[idx.length - 1];
  if (money) lines[first] = lines[first] ? `${lines[first]} | ${money}` : money;
  if (peak) lines[last] = lines[last] ? `${lines[last]} | ${peak}` : peak;
  return lines.join('\n');
}

const texts = {
  preview: compose(frame, DS.moneySegment(DEMO, 'en'), DS.peakSegment('en')),
  'preview.zh': compose(frame, DS.moneySegment(DEMO, 'zh-Hans'), DS.peakSegment('zh-Hans')),
};

// ── 4. ANSI → HTML ──
const SGR = {
  0: 'reset', 1: 'bold', 2: 'dim', 22: 'reset-intensity',
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'bright-black', 93: 'bright-yellow', 96: 'bright-cyan',
};
const FG = { black: '#3f3f46', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4', 'bright-black': '#5c6370', 'bright-yellow': '#e5c07b', 'bright-cyan': '#56b6c2' };
const X256 = { 196: '#ff0000', 202: '#ff5f00', 208: '#ff8700', 214: '#ffaf00', 220: '#ffd700', 190: '#d7ff00', 82: '#5fff00', 51: '#00ffff', 33: '#0087ff' };

function ansiToHtml(text) {
  let out = '';
  let fg = null;
  let bold = false;
  let dim = false;
  const st = () => {
    const css = [];
    if (fg) css.push(`color:${fg}`);
    if (bold) css.push('font-weight:700');
    if (dim) css.push('opacity:.55');
    return css.length ? `<span style="${css.join(';')}">` : '<span>';
  };
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      if (part) out += st() + part.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>';
      continue;
    }
    const codes = m[1].split(';').filter(Boolean).map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 38 && codes[i + 1] === 5) { fg = X256[codes[i + 2]] ?? null; i += 2; continue; }
      if (c === 0) { fg = null; bold = false; dim = false; continue; }
      if (c === 1) { bold = true; continue; }
      if (c === 2) { dim = true; continue; }
      if (c === 22) { bold = false; dim = false; continue; }
      if (c === 39) { fg = null; continue; }
      const name = SGR[c];
      if (name && FG[name]) fg = FG[name];
    }
  }
  return out;
}

const html = (body) => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0e1116">
<div style="padding:18px 22px;font:13px/1.65 'Cascadia Mono','Consolas','SF Mono','DejaVu Sans Mono',monospace;color:#dcdfe4;white-space:pre">${body}</div></body>`;

// ── 5. 截图 ──
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error('没找到 Edge/Chrome；HTML 已写在下面，你可以自己截图：');
  for (const [name, text] of Object.entries(texts)) {
    const f = join(tmpdir(), `${name}.html`);
    writeFileSync(f, html(ansiToHtml(text)));
    console.error(`  ${f}`);
  }
  process.exit(1);
}

mkdirSync(DOCS, { recursive: true });
for (const [name, text] of Object.entries(texts)) {
  const src = join(tmpdir(), `${name}.html`);
  const out = join(DOCS, `${name}.png`);
  writeFileSync(src, html(ansiToHtml(text)));
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    '--screenshot=' + out, '--window-size=1200,86', 'file:///' + src.replace(/\\/g, '/'),
  ], { stdio: 'ignore', timeout: 60_000 });
  console.log(`✅ ${out}`);
  if (process.argv.includes('--keep-html')) console.log(`   html: ${src}`);
}
