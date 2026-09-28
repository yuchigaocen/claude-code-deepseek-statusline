---
description: Install/wire the DeepSeek status line into Claude Code (runs the installer, then verifies the bar appears)
---

Install the DeepSeek status line on this machine. Read `INSTALL.md` at the plugin root first — it is one page:

```
Read "${CLAUDE_PLUGIN_ROOT}/INSTALL.md" and follow it.
```

Then install and confirm:

```sh
node "${CLAUDE_PLUGIN_ROOT}/install.mjs"
```

It copies the runtime files to `~/.claude/ds-statusline/`, backs up `settings.json`, and sets **only** the
`statusLine` key — `hooks` are never touched. If the shell cannot expand `${CLAUDE_PLUGIN_ROOT}`, ask the user
for the plugin's install path (usually under `~/.claude/plugins/`) and run `<that path>/install.mjs`.

After it prints, ask the user to confirm the bottom line of their window shows the bar. If it does, say so in a
sentence and stop — no progress narration, no extra checks. Only if it does **not** appear, work through
`INSTALL.md` §"If nothing appears".

To remove it later: `node "${CLAUDE_PLUGIN_ROOT}/uninstall.mjs"`.
