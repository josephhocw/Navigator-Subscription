# Archived section — "The two-bar theory" (Skill 3, Way 2 rebound timing)

Removed from the Master the Navigator guide's core skills page (`src/content/guides/master/core-skills.mdx`) on **2026-10-09** at Joseph's request — may be brought back later.

It was method 2 of the three ways to time the rebound under Skill 3 → Entry type 1 → "Wait for the rebound (Way 2)". It sat **between "#### 1. Secondary-trendline break" (after its `GuideFlow`) and "#### 3. Our signal — the fallback"**. Way 2 now lists two methods.

## To restore

1. Paste the markup block below back between the secondary-trendline-break section and the signal-fallback section.
2. Re-add the import at the top of `core-skills.mdx`, next to the other guide components:
   `import GuideMediaCard from '../../../components/guides/GuideMediaCard.astro';`
3. Put the surrounding text back to the three-method version:
   - The numbered list above "#### 1. Secondary-trendline break":
     ```mdx
     1. **A secondary-trendline break, if there's a trend to break — the best option.**
     2. **The two-bar theory — when there's no secondary trendline to draw.**
     3. **Our signal label — the fallback.**

     The first two get you in **earlier** than the signal label, which is why they come first.
     ```
   - Heading "#### 2. Our signal — the fallback" back to "#### 3. Our signal — the fallback".
   - Its first line back to "If neither of the above is available, the Navigator's own **B** or **S** signal is your cue." and "It's the later of the two entries" back to "It's the latest of the three entries".
4. The images `public/learn/lessons/two-bar-theory-buy.png` and `two-bar-theory.png` are still in the repo — nothing to re-add.

## Markup

```mdx
#### 2. The two-bar theory

If there's no clean secondary trendline to draw, fall back on this simple price-action check:

<GuideMediaCard src="/learn/lessons/two-bar-theory-buy.png" alt="A buy off the two-bar rule: a bar closes above the previous two bars' high">

For a **buy**, enter when a bar closes **above the last two bars** before it.

Here, price closes above the previous two bars' high — a buy.

</GuideMediaCard>

<GuideMediaCard src="/learn/lessons/two-bar-theory.png" alt="A sell off the two-bar rule: a bar closes below the previous two bars' low">

For a **sell**, enter when a bar closes **below the last two bars** before it.

Here, price closes below the previous two bars' low — a sell.

</GuideMediaCard>

In a strong trend you may struggle to find a bar that closes against it — and that difficulty is itself a sign of how strong the trend is.
```
