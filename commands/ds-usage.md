---
description: DeepSeek usage dashboard — balance, session cost (peak/off-peak split), tokens, cache hit rate, current rates
---

Show the user their DeepSeek usage dashboard for the current (or given) session.

```sh
node ~/.claude/ds-statusline/scripts/ds.mjs $ARGUMENTS
```

Useful flags to pass through `$ARGUMENTS` when the user asks for them:

- `--peak` — just the peak/off-peak state, the current Beijing time, and the rate in effect
- `--short` — one line: peak state, clock, cost, balance
- `--json` — machine-readable
- `--refresh` — force a transcript rescan and a synchronous balance fetch
- `--transcript <path.jsonl>` — a specific session instead of the newest one
- `--en` — English labels (default follows the system language: Chinese here)

If the script is not installed yet (no `~/.claude/ds-statusline/`), tell the user to run `/ds-setup`
first, or run it directly from the plugin root: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ds.mjs"`.

Report the numbers as-is — the cost figures are computed from the session transcript with DeepSeek's
official CNY rates (peak/off-peak and cache hit/miss priced separately), not estimated.
