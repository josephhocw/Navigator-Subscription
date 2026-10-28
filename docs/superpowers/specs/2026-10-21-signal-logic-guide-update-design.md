# Signal logic guide update — design

**Date:** 2026-10-21, rules revised 2026-10-28
**Status:** implemented and deployed to production on 2026-10-28 (Website `50786c1`) at Joseph's request, ahead of the script's publication (Dev bugs fixed, double-testing still in progress). Outstanding: screenshots #8 to #11 (settings window, SL lines; placeholders render meanwhile), #15 optional; the `GuideSettingsSections` strip positions and the Chart Lines setting names (`Show SL Lines [Main/Extended Channel]` assumed) need checking against the trimmed window.

## Why

The Navigator's buy and sell signals (B, S, EB, ES) no longer fire at the 50% entry line. They now fire on the close of the bar that completes a 3-bar confirmation after a line hit. The site explains the old rule in six places. The MA set also changes: MA 30 is removed and the orange MA 9 becomes an MA 5 with an adjustable length.

Verified against `RHO Navigator [Dev]` v531 (`USER;647f9023a57140d1be2996ca1a433790`) on 2026-10-21. The Dev build carries extra test settings and two things that will change before publishing (SL distance, B-turns-EB quirk), so the site follows Joseph's stated rules below, not the Dev code, where they differ.

## The rules (subscriber level)

Keep it at this depth. No setting names, no lookback values, no "arm" or "lock" jargon.

**Channel buy (B)**

1. Price hits support.
2. Three bars in a row close above the MA 5. Bars 2 and 3 also close above the support line (bar 1 may close below it, as long as it closed above the MA 5).
3. One of those bars closes above the bar before it: bar 2 closes above bar 1's high, or bar 3 closes above bar 2's high. A real push, not a drift.
4. On bar 3, the MA 5 has a positive inclination (sloping up).
5. B prints on bar 3 at its close. That close is the entry.

So a buy can form two ways: bar 1 closes below support but above the MA 5, then bars 2 and 3 close above both; or all three bars close above both the line and the MA 5. The first way gets you in one bar earlier.

The setup is dropped if 30 bars pass after the hit, or if price closes above the middle line first. One signal per hit.

**Extended buy (EB)**

Same steps, with three differences: the hit is the second touch of the extended support line, bars 2 and 3 close above the extended support line, and bar 3 must close no higher than 75% of the way from extended support to support. The first target is the support line, so at least 25% of that distance has to be left for profit; a close past the 75% mark leaves too little, and no EB prints.

**Sells (S, ES)** mirror everything downward: resistance hit, three closes below the MA 5, bars 2 and 3 also below resistance (or extended resistance), one bar closing below the previous bar's low, MA 5 sloping down on bar 3, S or ES at bar 3's close. Two ways again: bar 1 closes above resistance but below the MA 5, then bars 2 and 3 close below both; or all three close below both. Extended sell: bar 3 closes no lower than 75% of the way from extended resistance to resistance.

**B vs EB.** B always follows a support hit; EB always follows an extended-support hit. (Dev currently relabels a support-armed setup as EB when a bar closes below support. Joseph will fix this before publishing; the site does not mention it.)

**When your own judgement beats the signal (new, 2026-10-28).** The 3-bar rule is there so the entry is confirmed, but confirmation costs bars. When the bars are big or the channel is narrow, price can reach the other side of the channel within two bars, before bar 3 closes, and the opportunity is gone. The guide says so plainly: the label is the safe default; a trader who reads the chart may enter earlier on a line hit when the channel is narrow relative to the bar size, with the same SL. One screenshot (#14) shows the missed case.

**Not on the site (Joseph, 2026-10-28):** the script also requires B3's close to be at least 0.5 x ATR(14) beyond the line (above support for a buy). Left out of the guides to keep them simple. On the EB/ES cards the 75% rule is worded as "unless that close is too close to the support/resistance line", no numbers.

**Stop loss.** Unchanged: the SL line sits 1.5 bar heights beyond the line, and the Telegram message's SL is that same level.

**Moving averages.** One MA now: the MA 5, orange, on by default, length adjustable in the settings. MA 30 is gone. The MA 9 take-profit rule becomes the MA 5 take-profit rule, same steps.

**Chart Lines setting.** Only SL lines remain (main channel and extended channel). The entry lines are gone.

## Pages and sections to change

| # | File | Change |
| :-- | :-- | :-- |
| 1 | `web/src/content/guides/master/read-the-chart.mdx` | "What you see" MA bullet: one MA 5, adjustable, no MA 30. Overview caption. No separate section (Joseph, 2026-10-28: "not needed, put them in the cards"): the steps live on the B/EB/S/ES cards in `GuideLabelExamples`, each card's screenshot numbers the three bars, and a "When your own judgement beats the signal" callout with the narrow-channel shot (#14) follows the cards. "The entry and SL lines" becomes "The SL lines": callout, intro sentence, toggle caption. |
| 2 | `web/src/components/guides/GuideLabelExamples.astro` | B, EB, S, ES cards carry the 5 numbered steps (`steps`) plus a `note` line; blue numbered discs match the 1-2-3 on the screenshots. Header comment. |
| 3 | `web/src/components/guides/GuideZoneCards.astro` | Entry rows removed, SL rows kept. Header comment. Component name stays. |
| 4 | `web/src/components/guides/GuideSettingsSections.astro` | Chart Lines text (SL lines only). Moving Averages text (MA 5, length). Section strips and card count wait for the trimmed subscriber settings window. |
| 5 | `web/src/content/guides/master/core-skills.mdx` | "Our signal, the fallback" paragraph (line ~201), plus one sentence pointing back to the judgement callout (narrow channel, big bars). "MA 9 TP" heading, steps and caption become MA 5 (same image, renamed to `ma5-tp.png`). "Both entry types exit the same way" line. SL section link text. |
| 6 | `web/src/pages/how-it-works.astro` | Buy and sell captions ("rebound about halfway" wording). SVG panel comments. Pill position in the mock can stay. |
| 7 | `web/src/components/guides/GuideSignalGroups.astro` | "Fires at the buy zone" and "Fires at the extended buy zone" lead lines. |
| 8 | `../Navigator Business Resources/Engineering/navigator-indicator-documentation.md` | Short dated section at the top: B/S engine replaced, pointer to this spec. Full rewrite only after the script publishes. |
| 9 | `../MEMORY.md` (Navigator Business) | One entry: signal logic change, date, what the site says, pending screenshots. |

Not touched: `reading-the-signals.mdx` (timeframe and group text still true), `docs/brand/references/how-it-works-redesign/BRIEF.md` (historical brief).

## Screenshots Joseph supplies

All under `web/public/`. Capture on the 1h chart with Pepperstone data, same style as the current shots.

| # | Path | What to show |
| :-- | :-- | :-- |
| 1 | `learn/understanding/overview.png` | Whole chart with MA 5 only (no MA 30), both panels |
| 2 | ~~`learn/understanding/signal-buy-steps.png`~~ | Dropped 2026-10-28; the numbered bars sit on the label cards (#4 to #7) instead |
| 3 | ~~`learn/understanding/signal-extended-buy-steps.png`~~ | Dropped 2026-10-28, same reason |
| 4 | `learn/labels/buy.png` | B example with the three confirmation bars numbered 1-2-3 next to the bars |
| 5 | `learn/labels/extended-buy.png` | EB example, bars numbered |
| 6 | `learn/labels/sell.png` | S example, bars numbered |
| 7 | `learn/labels/extended-sell.png` | ES example, bars numbered |
| 8 | `learn/understanding/sl-lines.png` | All four SL lines labelled on one chart (Buy / Sell / Extended Buy / Extended Sell SL line). Received 2026-10-28, 808 x 459, one card in `GuideZoneCards` |
| 9 | ~~`learn/understanding/zone-lines-extended.png`~~ | Merged into #8: one toggle, `Show SL Lines`, no main/extended split (Joseph, 2026-10-28) |
| 10 | `learn/understanding/zone-toggles.png` | Chart Lines section, cropped from #11 (y 545-626). Done 2026-10-28 |
| 11 | `learn/understanding/settings-dialog.png` | Full Inputs tab, 462 x 692, received 2026-10-28. Section order is UI Panels, UI Labels (incl. Label Size), Moving Averages, Chart Lines; the MA 5 has a show/hide toggle only, no length setting, so the site no longer says the length is adjustable |
| 12 | `learn/lessons/signal-fallback.png` | B or S printing on the close in the core-skills context |
| 13 | `learn/lessons/ma5-tp.png` | Rename of `ma9-tp.png`, same image |
| 14 | `learn/understanding/signal-missed-narrow-channel.png` (new) | Narrow channel, big bars: a line hit where price reaches the other side within two bars, so no label or a late one. Raw candidate `discretion-narrow-channel.png` is 256 x 315, recapture at 2 to 3x |
| 15 | `learn/understanding/signal-sell-early.png` (new, optional) | A sell where bar 1 closed above resistance but below the MA 5, bars 2 and 3 below both: the earlier-entry case |
| 16 | `learn/understanding/label-hover.png` | Tooltip over an S label ("Support (4028.22)"), shown at its natural 219 x 181 under the label glossary. Received 2026-10-28. |

Optional: sell and extended-sell step shots. The text says "sells mirror", so these are not required. #15 is optional for the same reason.

### Captures received so far (2026-10-21)

Raw files in `../Navigator Business Resources/Guides/signal-logic-2026-10/raw/`. Nothing annotated or copied into `web/public/` yet (Joseph put all changes on hold until the script is tested, target next week).

| Raw file | Size | Covers | Annotation to do before use |
| :-- | :-- | :-- | :-- |
| `overview-ma5.png` | 1001 × 657 | #1 overview | Same style as the current `overview.png`: boxed labels with yellow arrows for "Previous Channel", "Current Channel", "Trend Analysis Panel", "Channel Levels Panel", plus an orange "MA 5" tag on the orange line. No MA 30 tag. |
| `buy-signal.png` | 287 × 269 | #2 buy steps, #4 label card B, #12 signal fallback | Mark the three bars as 1, 2, 3 (bar 3 carries the B). For the step shot, also mark the S hit. **Too small as captured**: the current label cards are about 900 px wide and the fallback target is 600 px+. Recapture the same spot at 2 to 3× (browser zoom 200% before snipping) and annotate that one. |
| `sell-signal.png` | 274 × 283 | #6 label card S, #12 signal fallback (sell version) | Same 1, 2, 3 marking as the buy. Same resolution problem, same fix. |
| `discretion-narrow-channel.png` (2026-10-28) | 256 × 315 | #14 missed opportunity | Narrow channel, big bars, S at the top then price at the bottom line two bars later. Too small, recapture at 2 to 3x with the labels readable. |
| `buy-steps-v2.png` (2026-10-28) | 305 × 358 | #2 buy steps, #4 B card, #12 fallback | S hit at the bottom, three bars above the MA 5, B on bar 3. Content right. Still about a third of the card width, recapture at 3x. |
| `extended-buy-steps.png` (2026-10-28) | 298 × 329 | #3 EB steps, #5 EB card | ES2 hit then EB. Content right but the support line above is out of frame, so the 75% level cannot be drawn. Recapture at 3x with support in frame. |
| `sell-v2.png` (2026-10-28) | 363 × 359 | #6 S card, #12 fallback (sell) | R hit, three bars below the MA 5, S on bar 3. Content right, recapture at 3x. |
| `extended-sell.png` (2026-10-28) | 398 × 344 | #7 ES card | ER2 hit then ES. Content right, resistance line below out of frame (fine for the card). Recapture at 3x. |

Joseph's plan (2026-10-28): #4 reuses #2, #5 reuses #3, #12 reuses #2 or #6, #13 not needed, #8 to #11 come later (placeholders first), #15 later. Still needed at usable size: #2, #3, #6, #7, #14 (all captured under 400 px wide, cards are 800 to 970 px).

## Approach

Write all copy now against the current image paths. Joseph drops screenshots in as he gets them. Nothing commits to `master` or deploys until the script publishes; Joseph deploys himself.
