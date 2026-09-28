#!/usr/bin/env node
/**
 * 卸载 —— 摘掉 statusLine 接线并删掉装过去的文件。
 *
 *   node uninstall.mjs                 先备份 settings.json，再删 statusLine 与安装目录
 *   node uninstall.mjs --keep-files    只摘接线，留着文件
 *   node uninstall.mjs --dry-run       只打印将要做什么
 *
 * 安全约定：**只在自己就是当前 statusLine 时才摘**（命令里必须出现安装目录），否则只提示、不动手；
 * 全程不碰 hooks；写之前先备份。
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const KEEP_FILES = argv.includes('--keep-files');
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HOME = homedir();
const raw = process.env.CLAUDE_CONFIG_DIR?.trim();
const CLAUDE_DIR = raw ? resolve(raw.replace(/^~(?=[\\/]|$)/, HOME)) : join(HOME, '.claude');
const DEST = resolve(opt('dest', join(CLAUDE_DIR, 'ds-statusline')));
const SETTINGS = join(CLAUDE_DIR, 'settings.json');

console.log(`\n  ${DRY ? '（dry-run：不会写任何东西）\n' : ''}`);

// ── 1. 摘接线 ──
if (!existsSync(SETTINGS)) {
  console.log(`  settings.json 不存在（${SETTINGS}），没什么可摘的`);
} else {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    console.error(`❌ 读不了 ${SETTINGS}: ${e.message}`);
    process.exit(1);
  }
  const cmd = settings.statusLine?.command ?? '';
  // 两种分隔符都要认：install.mjs 现在写正斜杠（官方要求），老版本写的是反斜杠。
  // 只比一种，Windows 上就会把"自己装的"判成"别人的"，于是静默拒绝卸载。
  const isOurs = cmd.includes(DEST) || cmd.includes(DEST.replace(/\\/g, '/'));
  if (!cmd) {
    console.log('  settings.json 里本来就没有 statusLine，跳过');
  } else if (!isOurs) {
    console.log('  ⚠️ 当前 statusLine 不是本插件装的，不动它：');
    console.log(`     ${cmd}`);
    console.log('     若要强制摘掉，请手动编辑 settings.json。');
  } else {
    if (!DRY) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${SETTINGS}.before-ds-statusline-uninstall-${ts}`;
      cpSync(SETTINGS, backup);
      console.log(`  🗄️ 已备份 → ${backup}`);
    }
    delete settings.statusLine;
    if (!DRY) writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    console.log('  ✅ 已摘掉 statusLine（hooks 未动）');
    console.log('     想恢复原状态栏：从上面那个备份里把 statusLine 拷回来。');
  }
}

// ── 2. 删文件 ──
if (KEEP_FILES) {
  console.log(`  ⏭ --keep-files：保留 ${DEST}`);
} else if (!existsSync(DEST)) {
  console.log(`  ${DEST} 不存在，跳过`);
} else {
  if (!DRY) rmSync(DEST, { recursive: true, force: true });
  console.log(`  ✅ 已删除 ${DEST}${DRY ? '（未真的删）' : ''}`);
}
console.log('');
