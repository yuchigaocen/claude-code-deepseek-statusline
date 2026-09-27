#!/usr/bin/env node
/**
 * 把上游 claude-hud 的构建产物内嵌进 vendor/ —— 跟进上游只需重跑这一条命令。
 *
 *   node tools/vendor-upstream.mjs [--tag v0.8.0] [--from <已克隆的目录>]
 *
 * 只取 dist/ 下的 .js（运行时要的），不取 .d.ts / .map（体积一半、运行无关）。
 * 同时拷上游 LICENSE 进 vendor/claude-hud/，并写 VENDORED.md 记录版本、commit、来源与时间。
 *
 * 为什么内嵌而不是依赖：Claude Code 的插件系统不能声明 statusLine，我们的状态栏入口需要一个
 * 稳定路径去 import HUD；内嵌后使用者 clone 即跑，不必先装别的包，也不必跑 npm。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'vendor', 'claude-hud');
const UPSTREAM = 'https://github.com/jarrodwatts/claude-hud';

const argv = process.argv.slice(2);
const tagArg = argv.find((a) => a.startsWith('--tag=')) ?? (argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : null);
const TAG = tagArg || 'v0.8.0';
const fromIdx = argv.indexOf('--from');
const FROM = fromIdx !== -1 ? argv[fromIdx + 1] : null;

// ── 取源 ──
let src = FROM;
let tempClone = null;
if (!src) {
  tempClone = join(tmpdir(), `claude-hud-${Date.now()}`);
  console.log(`clone ${UPSTREAM} @ ${TAG} ...`);
  execFileSync('git', ['clone', '--depth', '1', '--branch', TAG, UPSTREAM, tempClone], { stdio: ['ignore', 'ignore', 'inherit'] });
  src = tempClone;
}
if (!statSync(src).isDirectory()) throw new Error(`源目录不存在: ${src}`);

const commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const upstreamPkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
const distSrc = join(src, 'dist');
if (!statSync(distSrc).isDirectory()) throw new Error(`上游没有 dist/: ${distSrc}（需要已构建的 tag，或先 npm run build）`);

// ── 拷 .js ──
rmSync(DEST, { recursive: true, force: true });
// 用"读文本再写回"的方式拷，顺手把 CRLF 规范成 LF：本机 core.autocrlf 会把 clone 的工作区转成 CRLF，
// 于是拷进来的是带 \r 的文件（VENDORED.md 里就混进过一个 \r，git 直接把它当 binary 看）。
// 上游 git 对象里本来就是 LF，写回 LF 之后内容与上游对象逐字节一致。
const toLF = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
let files = 0;
let bytes = 0;
(function copyJs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) { copyJs(abs); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const rel = relative(distSrc, abs);
    const out = join(DEST, 'dist', rel);
    mkdirSync(dirname(out), { recursive: true });
    const text = toLF(readFileSync(abs));
    writeFileSync(out, text);
    files += 1;
    bytes += Buffer.byteLength(text);
  }
})(distSrc);

const license = toLF(readFileSync(join(src, 'LICENSE')));
writeFileSync(join(DEST, 'LICENSE'), license);

// ── 记录来源 ──
const firstLine = license.split('\n').find((l) => /copyright/i.test(l))?.trim()
  ?? license.split('\n').find((l) => l.trim())?.trim() ?? '';
writeFileSync(join(DEST, 'VENDORED.md'), `# 内嵌的上游代码

本目录是**第三方代码**，由 \`tools/vendor-upstream.mjs\` 自动拷入，请勿手改。

| | |
| --- | --- |
| 上游项目 | [jarrodwatts/claude-hud](${UPSTREAM}) |
| 描述 | ${upstreamPkg.description ?? ''} |
| 版本 | \`${upstreamPkg.version}\`（tag \`${TAG}\`） |
| commit | \`${commit}\` |
| 许可证 | ${upstreamPkg.license ?? '(见 LICENSE)'} — \`${firstLine.replace(/^Copyright/, 'Copyright')}\` |
| 取材范围 | 仅 \`dist/**/*.js\`（**${files} 个文件，${(bytes / 1024).toFixed(0)} KB**）；不含 \`.d.ts\` / \`.map\` |
| 拷贝日期 | ${new Date().toISOString().slice(0, 10)} |

## 为什么内嵌

Claude Code 的插件系统不能声明 \`statusLine\`（它只是 settings 键），所以状态栏入口必须从一个稳定路径
import HUD。内嵌后：使用者 clone 即跑、不必先装别的包；我们也不必去 patch 别人的包（补丁在包升级时必然失效）。

## 怎么更新

\`\`\`sh
node tools/vendor-upstream.mjs --tag v0.9.0
\`\`\`

更新后请跑一次 \`node scripts/selfcheck.mjs\`，并确认 \`vendor/claude-hud/LICENSE\` 与版权行没变。

## 我们的改动

**没有改动**。\`vendor/claude-hud/\` 里的文件与上游那个 tag 的 **git 对象**逐字节一致，可以对拍验证：

\`\`\`sh
git -C <upstream-clone> rev-parse HEAD        # 应等于上表 commit
git -C <upstream-clone> show ${TAG}:dist/index.js | diff - <(git show HEAD:vendor/claude-hud/dist/index.js)
\`\`\`

比对请走 \`git show\`（对象层）而不是直接 \`diff\` 工作区文件：本仓库用 \`.gitattributes\` 把行尾统一为 LF，
而本机 \`core.autocrlf\` 可能把工作区检出成 CRLF，直接对拍会看到一堆假的差异。
上面这条命令对每个文件都适用（换路径即可）。

功能上的差异全部在我们的 \`scripts/\` 层：官方口径计费、峰谷/时钟段、\`/ds-usage\` 大盘；
上游的 \`showCost\` 会被我们关掉（它按 Anthropic 价格算，对 DeepSeek 是错的）。
`);

console.log(`\n✅ vendor/claude-hud ← ${UPSTREAM} @ ${TAG} (${commit.slice(0, 8)})`);
console.log(`   ${files} 个 .js，${(bytes / 1024).toFixed(0)} KB`);
if (tempClone) rmSync(tempClone, { recursive: true, force: true });
