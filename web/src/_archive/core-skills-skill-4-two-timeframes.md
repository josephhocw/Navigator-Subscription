# Archived section — "Skill 4 — Trade with two timeframes"

Removed from the Master the Navigator guide's core skills page (`src/content/guides/master/core-skills.mdx`) on **2026-10-09** at Joseph's request — may be brought back later. The page now teaches three skills.

It was the **last section of the page**, straight after Skill 3's "The stop loss — about one bar beyond the line" (after the closing `]} />` of the stop-loss `GuideFlow`).

## To restore

1. Paste the markup block below back at the end of `src/content/guides/master/core-skills.mdx`.
2. Switch the skill count back from three to four in:
   - `core-skills.mdx` frontmatter: `description` (add back "and trading two timeframes at once") and `hubMeta: 4 skills`
   - `core-skills.mdx` intro paragraph (add back "and read two timeframes at once"; "Get these four right")
   - `src/pages/guides/index.astro` — Master track `blurb`
   - `src/pages/guides/master.astro` — page `description` and the intro `<p>`
   - `lib/email.ts` — the "core skills" mentions in the onboarding emails, if they were changed to three
3. No components or images to re-add — the section is plain Markdown.

## Markup

```mdx
## Skill 4 — Trade with two timeframes

**The trouble with one timeframe.** Watch only a higher timeframe and you'll see the trend clearly but your entries will be poor — too early or too late, without enough detail. Watch only a lower timeframe and you'll see every wiggle but miss the bigger picture, and end up taking trades against the larger trend.

**The method:**

- The **higher timeframe gives you direction.** Ask one question: should I be a buyer or a seller right now? Read the Navigator's trend and whether price is at support or resistance, then trade with that bias. Don't argue with the higher chart.
- The **lower timeframe gives you precision.** Zoom in for a cleaner entry in the same direction, using the entry methods from skill 3.

Putting it together: get your bias from the higher chart, wait for a clean signal in that direction on the lower chart, then enter on the lower chart, set your stop, and manage the trade.

### Pairing the two timeframes

Keep the lower timeframe roughly 10 to 25 times smaller than the higher. Any closer and the two charts show you the same thing; any wider and they lose their connection. Three pairings that work:

- **Daily with 1-hour** (about 24 times) — for swing traders holding positions for days to weeks.
- **1-hour with 5-minute** (about 20 times) — for trading within the day.
- **15-minute with 1-minute or 30-second** (15 to 30 times) — for very quick in-and-out trading.
```
