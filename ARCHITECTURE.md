# Architecture

How this status line is put together, why it is put together that way, and what to check before changing it.
Read this before touching `scripts/statusline.mjs` or re-vendoring the HUD.

## 1. Goals and non-goals

**Goals**

- Show DeepSeek's *billing* state (peak / off-peak, with a countdown), the live Beijing clock, the session's
  cost at **official rates**, and the account balance — all in the Claude Code status line, refreshing
  continuously.
- Never be the reason someone's Claude Code breaks: the status line is cosmetic, so every failure path must
  degrade to "less information", never to "no status line".
- Be installable by a stranger in one command, with no third-party package required and nothing patched.

**Non-goals**

- Replacing `claude-hud`. The HUD (context bar, git, tools/agents/todos, i18n) is upstream's job; we bundle
  it and add a segment.
- Accounting for spend that never reaches a Claude Code transcript (other tools using the same API key).
  We report *session* cost.
- Being a general DeepSeek dashboard. `/ds-usage` exists to explain the number in the status line.

## 2. Components

| Path | Responsibility | Owned by us? |
| --- | --- | --- |
| `scripts/statusline.mjs` | Status-line entry point. Runs the HUD, appends our segments, owns the frame cache and the cheap/full split. | yes |
| `scripts/peak-hours.cjs` | **Single source of truth** for peak windows, the Chinese holiday table, official rates, and cost arithmetic. | yes |
| `scripts/ds-usage.cjs` | Transcript scan (official-rate pricing), key-source resolution, balance record/cache, background balance fetch, reason codes and backoff, segment text/colour. | yes |
| `scripts/ds.mjs` | CLI behind `/ds-usage` and `/ds-peak`; `--short`, `--json`, `--peak`, `--refresh`, `--balance` (read-only diagnostics). | yes |
| `scripts/fetch-balance.mjs` | Detached process that fetches the balance once and writes the **record** (value or reason) to the cache. | yes |
| `scripts/selfcheck.mjs` | 52 offline assertions: peak boundaries, cost math, vendored integrity, key resolution, balance-failure fallbacks, entry smoke test. | yes |
| `install.mjs` / `uninstall.mjs` | Copy runtime files, then set/remove `statusLine` in `settings.json` (with backups). | yes |
| `commands/*.md` | `/ds-setup`, `/ds-usage`, `/ds-peak`. | yes |
| `tools/vendor-upstream.mjs` | Re-vendors the HUD from a pinned upstream tag. | yes |
| `vendor/claude-hud/` | The HUD, byte-identical to upstream (see `VENDORED.md`). | **no** — MIT, Jarrod Watts |

## 3. One render, two paths

Claude Code runs `statusLine.command`, hands it a JSON payload on stdin, and renders whatever comes back on
stdout. The whole status line is re-rendered every time — there is no per-line update, and `refreshInterval`
is per-command. So two parts with different refresh needs must be split *inside* our entry point:

```
stdin ──► frameKey() ──► frame cache hit? ──yes──► cheap path (~80ms)
                             │                        ├─ cached HUD frame
                             no                       ├─ cached account (cost/balance)
                             │                        └─ recompute peak badge + clock (pure time)
                             ▼
                        full path (~250ms)
                          ├─ loadConfig() from the vendored HUD, force showCost/showUsage off
                          ├─ hud.main({readStdin, loadConfig})  → captured stdout = the frame
                          ├─ refreshAccount(): rescan transcript (≤1/20s), maybe spawn balance fetch
                          └─ write frame cache {t, key, lang, frame}
                             │
                             ▼
                   compose(): money → end of first line, peak+clock → end of last line
```

**Frame invalidation.** The key is `transcript_path + size + mtime + HUD config mtime + model id + context
window size`, plus a 30-second TTL. It deliberately does **not** hash the whole stdin payload: that payload
carries `cost.total_duration_ms`, which changes every second, so hashing it would turn "cache" into "run the
HUD every tick". The transcript's `size+mtime` is the real event signal — Claude Code appends to it on every
message and tool call.

**Why the balance is fetched out-of-band.** A synchronous balance request measured ~600 ms on a cold run,
inside a command that Claude Code runs on every event — the status line would visibly lag. Instead
`refreshAccount()` checks a lock file and spawns `fetch-balance.mjs` detached; the render always uses the
cached value (with its age shown, and a ⚠ when it is older than 150 s).

**The key is resolved from many sources, and each candidate is tried.** A key can live in the process env
(`DEEPSEEK_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`), in managed settings, in
`~/.claude/settings{.local,}.json`, or in a project's `./.claude/settings{.local,}.json` — `settings.local.json`
first within each level, matching Claude Code's own precedence. Candidates are deduped by value and tried
in order, **stopping at the first usable 200**. Only 401/403 moves on to the next candidate: a timeout, a 5xx,
or an unparsable body is a host-level problem that another key cannot fix. Worst case is 3 attempts; the
ordinary single-key case is one request, exactly as before.

**Failures are recorded, not swallowed.** `fetch-balance.mjs` writes the outcome either way, including a
reason code (`nokey` / `auth` / `http` / `parse` / `net` / `unknown`) and a `retryAt`. The renderer shows the
reason only when it has **no usable value at all**; if a last-good reading exists it keeps rendering that,
per the house rule in §8. `retryAt` carries a **key fingerprint**, and the backoff is ignored whenever the
head candidate's fingerprint changed — so pasting a corrected key takes effect on the next tick instead of
waiting out a 6-hour `auth` backoff. That escape hatch is the whole reason a hard backoff is safe here.

## 4. Why the HUD is vendored, not patched, not depended on

The previous local setup (and the popular DeepSeek monitors) *patched* a third-party package's built files.
That breaks on every upgrade, pins the patch to specific source anchors, and — in one case — the package's
install script deletes the user's `SessionStart` hooks. So:

- **Vendored, not patched**: `vendor/claude-hud/` is upstream's build output, unmodified, 60 `.js` files
  (324 KB; `.d.ts`/`.map` are dropped). We import it and drive it through its own public seams
  (`main({readStdin, loadConfig})`) instead of editing it. `tools/vendor-upstream.mjs` re-vendors from a
  pinned tag in one command, and `VENDORED.md` records the exact commit so the tree can be diffed.
- **Vendored, not depended on**: a plugin manifest cannot declare `statusLine` (see §6), so the entry point
  must live at a stable path anyway; bundling the HUD means the user needs no second install, no npm, and no
  network.

Consequence: cost and balance are **ours**, so upstream's Anthropic-priced `showCost`/`showUsage` are forced
off at config load, and the segment carries DeepSeek numbers instead.

## 5. Cost and peak logic: one file, one rule

`scripts/peak-hours.cjs` owns everything price-related: the windows, the holiday table, the rate table, and
the bucket arithmetic. Consumers (`statusline.mjs`, `ds-usage.cjs`, `ds.mjs`) only format its output. Two
consequences worth preserving:

- Peak is computed in **Beijing time** (UTC+8, no DST) because that is the calendar DeepSeek bills on. The
  rule is `Mon–Fri, 09:00–12:00 and 14:00–18:00, excluding Chinese public holidays`; weekends are off-peak
  in full, including make-up workdays that land on a Saturday or Sunday.
- Cost is **per message**: each assistant message is priced with the rate in effect at *its* timestamp and
  with *its* model, so sessions that cross a switch or span a weekend come out right. Input is split into
  cache-hit and cache-miss; `input_tokens` and `cache_read_input_tokens` are exclusive on Claude Code
  transcripts, so `miss = input_tokens + cache_creation_input_tokens` and `hit = cache_read_input_tokens`.
  (The common `min(cache_read, input)` subtraction is wrong here and under-counts by ~2×.)

The holiday table covers 2026. For a year with no table the peak judgement falls back to weekends-and-hours
and the badge carries a `?` — a visible, honest degradation rather than a silent guess.

## 6. Platform constraints we designed around

Established against Claude Code 2.1.283 (its bundled `plugin-dev` docs and the installed build):

- A plugin **cannot** set `statusLine` (or any settings key). It is warned about and ignored in
  `plugin.json`. So `install.mjs` (or `/ds-setup`) is what wires it — there is no manifest-only path.
- Plugins get **no install-time hook**, and npm-sourced plugins are fetched with `--ignore-scripts`, so an
  installer cannot ride along with `plugin install`. Hence: a repo you clone and run.
- Component paths in a manifest must be relative and `./`-prefixed; `${CLAUDE_PLUGIN_ROOT}` works inside
  command bodies, which is how the `/ds-*` commands find the scripts.
- `refreshInterval` is a `statusLine` field (seconds, ≥1), documented as "in addition to event-driven
  updates". Without it the status line only refreshes on events, and an idle session shows a frozen clock.

## 7. Performance budget

Measured on Windows, Node 24, a session with a ~1.8 MB transcript:

| | cheap tick | full run |
| --- | --- | --- |
| wall time | ~80 ms | ~250 ms (transcript scan included) |
| frequency | every `refreshInterval` (1 s) | transcript change, or every 30 s |

At the 1-second default that is ~5% of one core while idle, ~8–11% while actively editing files. The knobs:
`refreshInterval` (the dominant term), `COST_TTL_MS`, `FRAME_TTL_MS`, `BALANCE_TTL_MS`. `install.mjs
--refresh-interval N` rewrites the setting.

**What the reason codes and backoff buy.** Before, a permanently-wrong key produced no value, so
`refreshAccount()` re-spawned the fetcher on every full run, throttled only to 15 s: roughly **240 process
spawns and 240 HTTPS requests per hour, all failing**. With `auth` at 6 h that is **1 spawn / 6 h**, and
`nokey` spawns nothing at all. `DS_CACHE_DIR` redirects the cache (used by selfcheck, handy for debugging).

Node's module-resolution note: the repo sets `"type": "module"` in `package.json` so that the vendored
`.js` files load as ESM directly; without it Node re-parses 60 files on every tick
(`MODULE_TYPELESS_PACKAGE_JSON`).

## 8. Failure modes and degradation

| Failure | Behaviour |
| --- | --- |
| `settings.json` unreadable | The installer refuses to write (never clobbers a file it cannot parse). |
| HUD config broken / HUD throws | Keep the **last good frame**; if there has never been one, print only our segment. |
| Empty stdin (Claude Code's settings verification) | Print nothing, exit 0. |
| No `transcript_path` / unreadable transcript | Cost and tokens stay at their last values; peak/clock still render. |
| Balance unavailable, **no** usable value ever | Segment shows `余额 n/a(reason)` — `无key` / `401` / `网络` / `异常` (`no-key` / `401` / `network` / `resp` in English). |
| Balance unavailable, but a last-good value exists | Keep showing that value (with its age, and ⚠ past 150 s). **The reason is not appended to it** — that keeps the success path byte-identical and follows "degrade to the last good value". Use `--balance` for the reason. |
| Year without a holiday table | Peak/off-peak from weekends+hours only, badge marked `?`, warning in `/ds-peak`. |
| `CLAUDE_HUD_DISABLE=1` | Whole status line silent (upstream's documented escape hatch) — respected. |
| `DS_PEAK_DISABLE=1` | Our segments are omitted; the HUD frame still renders. |

## 9. Privacy and security posture

- The API key is **read** at runtime from the sources listed in §3 (process env, managed settings,
  `~/.claude/settings{.local,}.json`, project `./.claude/settings{.local,}.json`) and used only for
  `GET https://api.deepseek.com/user/balance`. It is never written, logged, or copied anywhere.
- **The key is never passed to the detached child** — not on argv, not via the environment. It would show up
  in the process table (Task Manager's command-line column, `ps aux`). The child re-resolves it itself.
- `settings.apiKeyHelper` is **detected and reported** by `--balance` but never executed: running an
  arbitrary shell command from a process that fires every 15 s is a performance and security problem.
- `--balance` prints keys **masked** (at most 10 characters revealed, and short keys fully hidden) plus a
  truncated SHA-256 fingerprint for cross-machine comparison. It never prints a full key. It is also
  strictly read-only: no spawn, no cache writes.
- The only network call in the whole project is that balance request. No telemetry, no update checks.
- `cache/` (balance, cost baseline, frame) is gitignored; it contains your balance and session cost but no
  key material. `balance.json` may hold a **fingerprint** of the key that failed — 8 hex characters of a
  SHA-256, not reversible to the key.
- `install.mjs` touches exactly one key (`statusLine`) and backs up `settings.json` first; it never edits
  `hooks` — the thing the older npm monitors got wrong.

## 10. Tests and manual verification

```sh
node scripts/selfcheck.mjs            # 52 offline assertions (peak math, cost math, vendor integrity, keys, balance, entry)
node scripts/selfcheck.mjs --verbose  # show each assertion
```

The balance path is covered **offline**: the key resolvers take injectable `{claudeDir, env, cwd, managed}`
and `fetchBalance` takes an injectable transport, so 200 / 401 / 5xx / network-error / unparsable-body are all
simulated without touching the network. That injection is not incidental — `CLAUDE_DIR` is frozen at
`require()` time, so a test that wants a different config dir has to pass it in. The two end-to-end checks
spawn a child with `CLAUDE_CONFIG_DIR` and `DS_CACHE_DIR` pointed at a temp dir; nothing in the suite reads
or writes your real `~/.claude`.

What `selfcheck` deliberately does *not* cover, and how to check it by hand:

- **A real status line render**: point `CLAUDE_CONFIG_DIR` at a scratch directory, run `node install.mjs`,
  then start Claude Code with that config dir. This is the only way to exercise the actual TUI path.
- **One live success against a real DeepSeek platform key**: `node scripts/ds.mjs --balance`.
- **Timing after a change**: `node scripts/selfcheck.mjs` will catch correctness, not budget — re-measure
  with the table in §7 if you touch the hot path.

### Diagnosing a balance that will not show

`node scripts/ds.mjs --balance` (add `--cached` to skip the network probe, `--json` for machine-readable)
prints the effective `ANTHROPIC_BASE_URL` and whether its host is `api.deepseek.com`, every key source with
its state and a masked value, the fingerprint, each attempt's HTTP status, the last record and the backoff,
and a concrete fix. The most common finding is the one worth knowing about: a **relay** base URL means
`ANTHROPIC_AUTH_TOKEN` is the relay's token, which `api.deepseek.com` rejects with 401 — no key search will
fix that, the user needs a real DeepSeek platform key in `DEEPSEEK_API_KEY`. Exit code is 1 on `auth`, 0
otherwise, so scripts can branch on it.

## 11. Maintenance checklist

| Trigger | Action |
| --- | --- |
| Upstream `claude-hud` releases | `node tools/vendor-upstream.mjs --tag vX.Y.Z`, then `node scripts/selfcheck.mjs`, then eyeball a render. Check `VENDORED.md`'s diff note. |
| State Council publishes next year's holidays (each November) | Add the ranges to `HOLIDAY_RANGES` in `scripts/peak-hours.cjs`, run `selfcheck`, re-install so `~/.claude/ds-statusline/` updates. |
| DeepSeek changes prices | Update `RATES` in the same file (keys are `[peak, off-peak]`), run `selfcheck`. |
| A config manager rewrites `settings.json` | Restore `statusLine` from the timestamped backup beside it (this is a per-user environment issue, not a bug here). |
