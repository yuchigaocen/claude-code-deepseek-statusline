# Installing this status line

Run the installer. It writes one key (`statusLine`) into `settings.json`, backs that file up first, and never
touches `hooks`. Below are the two things it cannot know, and what to do if the bar does not appear.

Talk to the human in their own language. **Do not narrate checks as you go** — if everything works, the whole
job is one command, one glance at the bottom line, and one short sentence.

## Install

```sh
node install.mjs
```

Node ≥ 18. Keep the default destination `<config-dir>/ds-statusline/` — `/ds-usage` and `/ds-peak` hardcode it.
Useful flags: `--dry-run`, `--refresh-interval 2` (halves CPU), `--no-config`, `--no-statusline`, `--dest <dir>`.

**On Windows, check `git --version` first.** Claude Code runs the `statusLine` command through **Git Bash**;
with no Git there is no shell to run it, and the bar is simply blank — the installer warns about this, and it is
the one prerequisite a machine can be missing while everything else looks perfect.

## Two things the installer cannot see

- **A config manager / provider switcher** (CC Switch and similar) rebuilds `settings.json` from its own
  *common config* plus the active provider profile, so a `statusLine` living only in `settings.json` is gone at
  the next provider switch. If this machine has one, put the same `statusLine` value in its **common config**
  too — back up its database first, or paste it in the tool's own UI.
- **The install directory needs its own `package.json`** containing `{"type": "module"}`. The installer writes
  it; if you ever copy the runtime files by hand, add it — the vendored HUD is upstream ESM in `.js` files, and
  without that file an older Node renders **nothing at all**, silently.

## Then ask the human to look

The status line redraws on the next interaction. The human confirming the bottom line is there **is** the test.
If it is: stop there — one or two lines, no summaries.

## If nothing appears — only then

In order: restart Claude Code once → reopen `settings.json` and check the `statusLine` key is still present →
run `claude --debug` in that folder and look for exactly these strings:

| In the log | Meaning |
| --- | --- |
| `workspace trust not accepted` | accept the trust prompt for that folder; a parent folder's trust does not count, and home-dir trust never persists |
| `disableAllHooks is true` | that key suppresses the status line |
| no `statusLine` lines at all | the config being read is not the one you wrote (a switcher, or a different `CLAUDE_CONFIG_DIR`) |
| the command runs but prints nothing | the install directory is missing its `package.json` (above) |
| on Windows nothing runs at all, and the agent's own PowerShell commands work fine | no **Git → no Git Bash**. Claude Code needs it to execute the command (binary string: `Git Bash was not found. Install Git for Windows`). Install Git, restart Claude Code fully. |

If none of that explains it, then collect these two outputs and hand them over verbatim:

```sh
node "<dest>/scripts/ds.mjs" --balance          # masks keys; safe to paste
node "<checkout>/tools/make-sample-stdin.mjs" --transcript "<checkout>/nope.jsonl" \
  | node "<dest>/scripts/statusline.mjs"        # must print at least one coloured line
```

## Undo

`node uninstall.mjs` (removes a `statusLine` only when it points at this install), or restore the
`.before-ds-statusline-*` backup next to `settings.json`.
