---
description: DeepSeek peak/off-peak status — current period, time until the next switch, rates in effect
---

Tell the user whether DeepSeek is currently in peak or off-peak billing, how long until the next switch,
and what rate is in effect.

```sh
node ~/.claude/ds-statusline/scripts/ds.mjs --peak
```

Notes to relay if relevant:

- Peak hours are **09:00–12:00 and 14:00–18:00 Beijing time, Monday–Friday, excluding Chinese public
  holidays**; every other hour is off-peak, and off-peak costs exactly half. Weekends are off-peak all
  day, including make-up workdays that fall on a weekend.
- The switch happens on the minute, so "how long until the next switch" is exact to the second.
- If the script prints a warning that the current year has no holiday table, the peak judgement ignores
  Chinese public holidays for that year — offer to update `scripts/peak-hours.cjs` (the holiday ranges
  live at the top of that file).
