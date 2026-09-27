# 内嵌的上游代码

本目录是**第三方代码**，由 `tools/vendor-upstream.mjs` 自动拷入，请勿手改。

| | |
| --- | --- |
| 上游项目 | [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) |
| 描述 | Real-time statusline HUD for Claude Code |
| 版本 | `0.8.0`（tag `v0.8.0`） |
| commit | `ef5f1c8b167572ad1443c70629763ea8780af96b` |
| 许可证 | MIT — `Copyright (c) 2026 Jarrod Watts` |
| 取材范围 | 仅 `dist/**/*.js`（**60 个文件，316 KB**）；不含 `.d.ts` / `.map` |
| 拷贝日期 | 2026-09-27 |

## 为什么内嵌

Claude Code 的插件系统不能声明 `statusLine`（它只是 settings 键），所以状态栏入口必须从一个稳定路径
import HUD。内嵌后：使用者 clone 即跑、不必先装别的包；我们也不必去 patch 别人的包（补丁在包升级时必然失效）。

## 怎么更新

```sh
node tools/vendor-upstream.mjs --tag v0.9.0
```

更新后请跑一次 `node scripts/selfcheck.mjs`，并确认 `vendor/claude-hud/LICENSE` 与版权行没变。

## 我们的改动

**没有改动**。`vendor/claude-hud/` 里的文件与上游那个 tag 的 **git 对象**逐字节一致，可以对拍验证：

```sh
git -C <upstream-clone> rev-parse HEAD        # 应等于上表 commit
git -C <upstream-clone> show v0.8.0:dist/index.js | diff - <(git show HEAD:vendor/claude-hud/dist/index.js)
```

比对请走 `git show`（对象层）而不是直接 `diff` 工作区文件：本仓库用 `.gitattributes` 把行尾统一为 LF，
而本机 `core.autocrlf` 可能把工作区检出成 CRLF，直接对拍会看到一堆假的差异。
上面这条命令对每个文件都适用（换路径即可）。

功能上的差异全部在我们的 `scripts/` 层：官方口径计费、峰谷/时钟段、`/ds-usage` 大盘；
上游的 `showCost` 会被我们关掉（它按 Anthropic 价格算，对 DeepSeek 是错的）。
