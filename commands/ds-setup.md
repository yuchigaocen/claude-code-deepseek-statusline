---
description: Install/wire the DeepSeek status line into Claude Code (writes settings.json statusLine, backs it up first)
---

Wire the DeepSeek status line into this machine's Claude Code config.

Run the installer from the plugin root. It copies the runtime files to `~/.claude/ds-statusline/`,
backs up `settings.json`, and sets **only** the `statusLine` key (hooks are left untouched):

```sh
node "${CLAUDE_PLUGIN_ROOT}/install.mjs"
```

If the user wants to preview first, add `--dry-run`. If the shell cannot expand `${CLAUDE_PLUGIN_ROOT}`,
ask the user for the plugin's install path (or find it under `~/.claude/plugins/`) and run `node <that path>/install.mjs`.

After it finishes:

1. Show the user the exact `statusLine.command` the installer printed, plus the `refreshInterval` it wrote
   (default 1 second — that is what makes the peak countdown and clock tick; mention it can be raised to
   lower CPU cost).
2. Tell them it takes effect on the next statusline refresh (no restart needed), and give them the
   one-off self check: `node ~/.claude/ds-statusline/scripts/ds.mjs --peak`.
3. If they use a config manager that rewrites `settings.json` (e.g. a provider switcher), warn that it may
   overwrite the `statusLine` key, and that the backup file next to `settings.json` has the original value.

To remove it later: `node "${CLAUDE_PLUGIN_ROOT}/uninstall.mjs"`.
