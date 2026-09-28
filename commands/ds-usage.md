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

**If the balance is not showing**, run `--balance` — it is the diagnostic for exactly that. It prints the
effective `ANTHROPIC_BASE_URL` and whether it points at `api.deepseek.com`, every key source with a masked
value, each attempt's HTTP status, the backoff, and a concrete fix. Add `--cached` to skip the network probe.
It is read-only (no background process, no cache writes) and never prints a full key, so its output is safe
to paste. The usual finding: the base URL is a **relay**, so `ANTHROPIC_AUTH_TOKEN` is the relay's token and
DeepSeek rejects it with 401 — the fix is a real DeepSeek platform key in `DEEPSEEK_API_KEY`. Exit code is 1
when the key was rejected, 0 otherwise. When the balance does render, `余额 n/a(<reason>)` names the cause
inline (`无key` / `401` / `网络` / `异常`).

If the script is not installed yet (no `~/.claude/ds-statusline/`), tell the user to run `/ds-setup` first
(it follows `INSTALL.md` on this machine), or run it directly from the plugin root:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/ds.mjs"`.

Report the numbers as-is — the cost figures are computed from the session transcript with DeepSeek's
official CNY rates (peak/off-peak and cache hit/miss priced separately), not estimated.
