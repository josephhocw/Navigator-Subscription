# Master the Navigator — guide revamp (design)

*Date: 2026-06-30. Track: `/guides/master`. Status: approved, building on preview.*

## Goal

Re-order and re-focus the Master the Navigator guide so the **Core Skills** (today's
"Navigator Level Up" / "Core skills") become the centrepiece, the rigid six-setup
strategy walkthrough is dissolved, and entry/take-profit/stop-loss are taught off the
**lines** rather than fixed formulas. The precise old formulas survive as an optional
collapsible reference.

## Stage line-up (5 stages, was 5)

| # | Slug | Title | Change |
|---|---|---|---|
| 1 | `read-the-chart` | Understand the features | Light edit. Keep the lines/labels/panels/settings reference. Add a one-line note where B/S labels are described: the signal fires at 50% of the half-channel-width (sell label halfway between resistance and middle; buy label halfway between support and middle). Repoint the old `trade-setups` link → `core-skills`. |
| 2 | `core-skills` | Core skills of the Navigator | **Heavy rework — the centrepiece.** 4 skills (below). |
| 3 | `tips` | Tips | **New file.** The six tips lifted out of the old `trade-setups`. |
| 4 | `reading-the-signals` | Reading the Telegram signals | Keep. Repoint the `trade-setups` link → `core-skills`. |
| 5 | `set-your-alerts` | Set your alerts (optional) | Keep. Add a closing block: view full trading history / manage trades → `/guides/trading/your-trading-terminal`. |

The old `trade-setups.mdx` stage is removed: its six named setups stop being a
standalone walkthrough, its six tips become stage 3, and its precise formulas (entry
%, SL %, TP1/TP2, MA9 TP) move into the Core Skills collapsible.

## Core Skills — the 4 skills

1. **Pick the best channel** (kept). Without a good channel the lines/signals aren't
   trustworthy. Compare timeframes; green channel = quick confidence check.
2. **Draw parallel lines** (expanded). Two uses: project *inside* the channel for extra
   support/resistance (new), and *outside* at overshoots. How-to (trendline tool →
   clone → connect 2–3 pivots) kept.
3. **Enter & exit off the lines** (big rework, absorbs old timing skill + setup mechanics):
   - Entry step 1: wait for price to hit a line (Navigator line or a parallel line).
   - Entry step 2 — pick a method:
     - *Aggressive*: enter right at the line. Higher reward, higher risk.
     - *Safer (rebound/retrace)*, timed in priority order: (1) secondary-trendline break
       — best; (2) two-bar theory — if no secondary trendline; (3) our signal at 50% of
       the width — fallback. (1) and (2) get you in earlier than the label.
   - Take profit: the parallel and Navigator lines (middle, far side, extended,
     hand-drawn). Scale out across them.
   - Stop loss: about one average bar height beyond the line. No fixed points/%.
   - **Collapsible "exact rules"**: the six scenarios' precise entries (50% HCW / 50% of
     extended width), SLs (35% HCW / 50% width), TP1/TP2 logic, and the MA9 TP rule.
4. **Trade with two timeframes** (kept). Higher TF = direction, lower TF = entry; pair
   ~10–25× apart.

## Implementation notes

- **Restructure:** create `src/content/guides/master/`; move the (rewritten) stage MDX
  in from `web/_wip/master-guide/`; restore the hub from `master.astro.original` over the
  placeholder `src/pages/guides/master.astro`. Keep `_wip` as a backup until signed off.
- **New component:** `GuideDetails.astro` — native `<details>`, collapsed by default,
  styled with the site tokens — for the exact-rules block.
- **Images:** most existing `/learn/...` shots carry over (secondary-trendline, two-bar,
  zone-lines, parallel-line, multi-timeframe all exist). Two new shots would help and are
  flagged as TODOs for Joseph to capture — they are **not** blockers; sections ship
  without them: (a) aggressive-vs-rebound entry, (b) the bar-height stop loss.

## Editorial

Per `About Me/writing-rules.md` + the Navigator workstation rules: plain English for a
50s–60s audience, British spelling, sentence-case headings, "the Navigator", pricing in
SGD where it appears. Customer-facing prose gets a humanizer pass before sign-off.
