#!/usr/bin/env node
/**
 * 部署到 Claude Code —— 把状态栏插件装到本机。
 *
 *   node install.mjs                      装到 ~/.claude/ds-statusline 并写入 statusLine
 *   node install.mjs --dry-run            只打印将要做什么，不写盘
 *   node install.mjs --dest <dir>         换安装目录
 *   node install.mjs --refresh-interval 2 定时刷新间隔（秒，默认 1；传 0 = 不加定时器）
 *   node install.mjs --no-statusline      只拷文件，不动 settings.json
 *
 * 为什么需要这一步：Claude Code 的插件系统**不能**声明 statusLine（它只是 settings 键，
 * 插件清单里写它只会被警告并忽略），所以状态栏必须由用户侧的 settings.json 接上。
 * 本脚本只改 `statusLine` 这一个键，**不碰 hooks**，并会先备份。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY = flag('dry-run');
const SKIP_STATUSLINE = flag('no-statusline');
const refreshArg = opt('refresh-interval', '1');
const refreshInterval = Number.parseInt(refreshArg, 10);
if (Number.isNaN(refreshInterval) || refreshInterval < 0) {
  console.error(`--refresh-interval 要是 ≥0 的整数（0 表示不加定时器），收到: ${refreshArg}`);
  process.exit(2);
}

const HOME = homedir();
function resolveClaudeDir() {
  const raw = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return join(HOME, '.claude');
  const expanded = raw.replace(/^~(?=[\\/]|$)/, HOME);
  return resolve(expanded);
}
const CLAUDE_DIR = resolveClaudeDir();
const DEST = resolve(opt('dest', join(CLAUDE_DIR, 'ds-statusline')));
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const NODE = process.execPath;

const log = (s) => console.log(s);
const say = (label, msg) => log(`  ${label} ${msg}`);

log('');
log('  Claude Code · DeepSeek statusline');
log(`  ${DRY ? '（dry-run：不会写任何东西）' : ''}`);
log('');

// ── 1. 检查源 ──
for (const need of ['scripts/statusline.mjs', 'scripts/peak-hours.cjs', 'scripts/ds-usage.cjs', 'vendor/claude-hud/dist/index.js']) {
  if (!existsSync(join(ROOT, need))) {
    console.error(`❌ 源文件缺失: ${need}\n   请在仓库根目录运行（git clone 后 cd 进去再跑）。`);
    process.exit(1);
  }
}

// ── 2. 拷文件 ──
const copied = [];
function copyInto(rel) {
  const from = join(ROOT, rel);
  if (!existsSync(from)) return;
  const to = join(DEST, rel);
  if (!DRY) {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  copied.push(rel);
}
log(`📦 安装到 ${DEST}`);
if (!DRY) {
  // 先清掉上一次的代码（vendored 文件改名/删除时不会留残骸），但保留 cache/（余额与基线）
  for (const stale of ['scripts', 'vendor']) rmSync(join(DEST, stale), { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
}
copyInto('scripts');
copyInto('vendor');
for (const f of ['LICENSE', 'NOTICE', 'VERSION']) copyInto(f);
if (!DRY) {
  try {
    writeFileSync(join(DEST, 'VERSION'), readFileSync(join(ROOT, 'package.json'), 'utf8').match(/"version":\s*"([^"]+)"/)?.[1] + '\n');
  } catch { /* 没有 package.json 就算了 */ }
}
say('✅', `拷入 ${copied.filter((c) => statSync(join(ROOT, c)).isDirectory()).map((c) => `${c}/`).join(' ')} 等 ${copied.length} 项`);

// ── 3. 接上 statusLine ──
const command = `"${NODE}" "${join(DEST, 'scripts', 'statusline.mjs')}"`;
if (SKIP_STATUSLINE) {
  say('⏭', '--no-statusline：跳过 settings.json，请自行把下面这行写进 statusLine.command：');
  log(`     ${command}`);
} else {
  let settings = {};
  if (existsSync(SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    } catch (e) {
      console.error(`❌ 读不了 ${SETTINGS}: ${e.message}\n   先修好它（或备份后删掉），我不会覆盖一个解析不了的文件。`);
      process.exit(1);
    }
  } else {
    say('ℹ️', `${SETTINGS} 不存在，将新建`);
  }

  const before = JSON.stringify(settings.statusLine ?? null);
  settings.statusLine = { type: 'command', command, ...(refreshInterval > 0 ? { refreshInterval } : {}) };
  const after = JSON.stringify(settings.statusLine);

  if (existsSync(SETTINGS) && !DRY) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${SETTINGS}.before-ds-statusline-${ts}`;
    cpSync(SETTINGS, backup);
    say('🗄️', `已备份原 settings.json → ${backup}`);
  }
  if (!DRY) writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  say('✅', `statusLine ${before === after ? '已是目标值（未变）' : '已写入'}`);
  log(`     command         ${command}`);
  log(`     refreshInterval ${refreshInterval > 0 ? `${refreshInterval} 秒（每秒刷新让峰谷/时钟走起来；0 = 不加定时器）` : '未设置（只在事件驱动时刷新）'}`);
  if (before !== 'null' && !before.includes(DEST.replace(/\\/g, '\\\\'))) {
    say('⚠️', `原本的 statusLine 指向别处，已被覆盖（备份里有原值）：${before}`);
  }
  const hookKeys = Object.keys(settings.hooks ?? {});
  if (hookKeys.length) say('ℹ️', `hooks 原样保留：${hookKeys.join(' / ')}`);
}

// ── 4. 收尾 ──
log('');
if (DRY) {
  log('  dry-run 结束。去掉 --dry-run 就会真的写盘。');
} else {
  log('  ✨ 装好了。下一条消息起状态栏就会变（不用重启）。');
  log('');
  log('  自检：    node ' + join(DEST, 'scripts', 'ds.mjs') + ' --peak');
  log('  卸载：    node ' + join(ROOT, 'uninstall.mjs'));
  log('  关掉本段（只留 HUD）：在环境变量里设 DS_PEAK_DISABLE=1');
  log('  关掉整条状态栏：    CLAUDE_HUD_DISABLE=1');
}
log('');
