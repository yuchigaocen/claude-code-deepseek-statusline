# claude-code-deepseek-statusline

给 Claude Code 的状态栏加一段 **DeepSeek** 信息：峰/谷计费状态与倒计时、实时北京时间、本会话的
**官方口径费用**、以及账户余额。

```
[deepseek-flash] ███░░░░░░░ 25.0% (253.7k/1.0M) | my-project | ⏱️ 5h 17m | 费用 +¥0.0084 ¥3.10  余额 ¥42.00 12s  v0.1.0
◐ Bash: npm test | ✓ Bash ×10 | ✓ Edit ×8 | 🟢DS谷 12h37m36s | 20:22:23
```

钱那一段在**第 1 行末尾**（跟会话时长并列）：距上次刷新的增量、本会话累计、余额与这次读数的年龄、插件版本。
峰谷徽标与北京时间在**最后一行末尾**，跟工具活动并列。

*[English README](README.md)*

## 为什么要它

现有的 DeepSeek 状态栏插件有两个错、一个缺：

1. **看不见峰谷。** DeepSeek 高峰与空闲**差一倍价**，而高峰时段是固定的（北京时间、工作日、排除法定节假日）。
   你想一眼看到"我现在是不是在付双倍价、还要多久"。
2. **费用算错。** 流传的那组费率（`¥3 / ¥6 / ¥0.025` 每百万）哪个档都对不上；更严重的是常见实现先算
   `min(cache_read, input_tokens)` 再相减 —— 但在 Claude Code 的转录里 `input_tokens` 与
   `cache_read_input_tokens` 是**互斥**的，于是未命中输入被减成 0、整个会话按命中价计价。实测少算一倍以上。
3. **余额看不见**（这个是真花钱的）。

本项目按**每条消息发生时刻**的档位、用官方人民币价逐条计价，所以跨过换价点、跨周末的会话也算得对。

## 依赖

- **Node ≥ 18**
- **Claude Code** 走 DeepSeek 后端：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，
  密钥放在 `settings.json` 的 `ANTHROPIC_AUTH_TOKEN`
- 只有余额那一段需要能读到密钥（也可用环境变量 `DEEPSEEK_API_KEY`），其余功能不依赖它

## 安装

**从 clone 装**（推荐，一步到位，不经过插件系统）：

```sh
git clone https://github.com/yuchigaocen/claude-code-deepseek-statusline
cd claude-code-deepseek-statusline
node install.mjs
```

安装器把运行时文件拷到 `~/.claude/ds-statusline/`，**先备份** `settings.json`，然后**只改 `statusLine` 一个键**。
**绝不碰 `hooks`** —— 有些状态栏包的安装脚本会删掉你的 `SessionStart` 钩子，这个不会。

同时会写 `statusLine.refreshInterval`（默认 `1` 秒）。倒计时和时钟能一秒一跳就是靠它；
`--refresh-interval 2` 可省一半开销，`--refresh-interval 0` 表示不加定时器（只在事件驱动时刷新）。

**作为 Claude Code 插件装**（能拿到 `/ds-setup`、`/ds-usage`、`/ds-peak` 三个命令；注意插件清单
**无法**声明 `statusLine` —— Claude Code 只认 `settings.json`，所以真正接线的是 `/ds-setup`）：

```
/plugin marketplace add yuchigaocen/claude-code-deepseek-statusline
/plugin install ds-statusline@claude-code-deepseek-statusline
/ds-setup
```

### 验证

```sh
node ~/.claude/ds-statusline/scripts/ds.mjs --peak     # 峰谷状态、下次切换、当档费率
node ~/.claude/ds-statusline/scripts/ds.mjs            # 完整大盘
```

状态栏本身在下次刷新时就会变（不用重启）。想不动真实配置试一遍，把 `CLAUDE_CONFIG_DIR` 指到临时目录：

```sh
CLAUDE_CONFIG_DIR=/tmp/scratch node install.mjs && CLAUDE_CONFIG_DIR=/tmp/scratch claude
```

### 卸载

```sh
node uninstall.mjs                 # 摘掉 statusLine（只在自己装的才摘）+ 删文件
node uninstall.mjs --keep-files
```

安装与卸载都会在 `settings.json` 旁边留一份带时间戳的备份。

## 你会得到什么

| 命令 | 作用 |
| --- | --- |
| `/ds-setup` | 安装/接线（在你同意下跑安装器） |
| `/ds-usage` | 大盘：余额、本会话费用（峰/谷拆分）、token、缓存命中率、当前档费率 |
| `/ds-peak` | 只看峰谷状态、北京时间、当档费率 |
| `scripts/ds.mjs --short / --json` | 一行 / 机器可读（写脚本方便） |

## 计费口径

官方人民币价（每百万 tokens，[来源](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）：

| deepseek-flash | 高峰 | 空闲 |
| --- | --- | --- |
| 缓存命中 | ¥0.04 | ¥0.02 |
| 缓存未命中 | ¥2 | ¥1 |
| 输出 | ¥8 | ¥4 |

`deepseek-v4-pro` 是 ¥0.30/0.15 · ¥9/4.5 · ¥27/13.5。空闲价恒为高峰半价。

**高峰时段：北京时间周一至周五 09:00–12:00 与 14:00–18:00，排除中国法定节假日。** 其余全为空闲 ——
包括周末，也包括**调休上班的周六/周日**（DeepSeek 按日历算，不按你上不上班算）。

节假日表在 `scripts/peak-hours.cjs` 顶部，目前是 2026 年。没有表的年份只按"周末 + 时段"判定，
结果显示会带 `?`。国务院每年 11 月公布次年安排 —— 把区间加进 `HOLIDAY_RANGES`、跑一次
`node scripts/selfcheck.mjs`，如果你是从 clone 装的，再跑一次 `node install.mjs` 让
`~/.claude/ds-statusline/` 里的副本更新。

## 它是怎么跑的

```
scripts/statusline.mjs        入口：跑 HUD，再把我们这段拼上去
├── vendor/claude-hud/        内嵌的上游 claude-hud，未改动（见 vendor/claude-hud/VENDORED.md）
├── scripts/peak-hours.cjs    峰谷时段、节假日、官方价、算钱
├── scripts/ds-usage.cjs      扫转录（官方口径计价）、余额缓存
└── scripts/ds.mjs            /ds-usage 与 /ds-peak 背后的 CLI
```

两条刷新路径 —— 因为 Claude Code 的 statusLine 只有一个命令、每次整块重渲染，没法给两部分各配触发器：

- **便宜路径**（约 80ms，每秒 tick）：复用缓存下来的 HUD 整帧，只重算峰谷段与时钟
- **完整路径**（约 250ms，转录变化时 + 最多每 30 秒一次）：跑 HUD、重扫转录算费用、按需补余额缓存

余额由**游离的后台进程**抓取 —— 状态栏永远不等网络。1 秒默认值的实测开销：空闲约 **5% 单核**，
连续编辑文件时约 **8–11%**。嫌高就调大 `refreshInterval`，段还在，只是秒数会跳着走。

帧的失效判定用转录的 `size`+`mtime`、HUD 配置的 `mtime`、模型 id 与上下文窗口 —— **刻意不**哈希整包
statusline 载荷，因为里面有 `cost.total_duration_ms` 这种每秒都变的计时器，拿它当 key 会让缓存形同虚设。

设计取舍、失效行为、性能预算与维护清单见 **[ARCHITECTURE.md](ARCHITECTURE.md)**（英文）。

## 已知限制

- **标签语言跟随 HUD 的 `language` 设置**（`~/.claude/plugins/claude-hud/config.json`），默认英文。
  想要中文就设 `{"language": "zh-Hans"}`；单次命令可用 `--zh` / `--en` 强制。
- Anthropic 风格的用量条被关掉了：DeepSeek 没有对应的额度接口可填，上游的费用估算又按 Anthropic 价格算。
  我们改成显示 DeepSeek 自己的数字。
- 如果你用会重写 `settings.json` 的配置管理器（比如供应商切换器），它可能会丢掉 `statusLine` 键。
  旁边那份带时间戳的备份里存着要恢复的值。
- `scripts/ds.mjs` 是从 Claude Code 的转录算的，看不到没进转录的流量（别的工具用同一个 key），
  所以它是**会话**费用，不是账户总支出。

## 致谢与许可

- HUD 本体（上下文条、git、tools/agents/todos、多语言……）来自
  **[jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud)**（作者 Jarrod Watts，MIT），
  以**未改动**的方式内嵌在 `vendor/claude-hud/` —— 那个目录保留了自己的 `LICENSE` 与记录版本、commit 的
  `VENDORED.md`。我们的改动只在 `scripts/`、`install.mjs`、`uninstall.mjs`。
- 其余部分：MIT © 2026 yuchigaocen。见 `LICENSE` 与 `NOTICE`。
