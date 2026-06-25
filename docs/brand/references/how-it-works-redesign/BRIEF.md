# Brief — "How it works" page redesign (RHO Market Navigator)

You are one of 5 designers each producing a **competing full-page redesign** of the
RHO Market Navigator "How it works" page. Same facts, same brand, same content
requirements for everyone — you differ **only in layout and visual language**. Your
specific design direction is given in your dispatch prompt. This file is the shared
source of truth. Read it fully before designing.

The page being replaced lives at `web/src/pages/how-it-works.astro`. It is "quite ugly"
and the trade examples on it are **wrong**. Your job is to make a page that (a) looks
genuinely premium, (b) explains the Navigator clearly to a non-technical 50s–60s
audience, and (c) actively entices the reader to subscribe.

---

## 1. Who this is for / what the product is

- **RHO Market Navigator** is a TradingView indicator built by Joseph and maintained
  with another programmer. It draws a price **channel** (support floor, resistance
  ceiling, dashed middle line) that redraws itself as the market moves, and prints
  plain **buy / sell / breakout labels** on the chart when price reacts at those levels.
- It is **not** an autopilot. It never places a trade. It shows likely turning points;
  the trader decides and places the trade.
- **Audience: older (40s–60s, many late 50s to 60s), not tech-savvy, all interested in
  trading.** Plain words. Big, legible type. Generous spacing. Strong colour contrast.
  Nothing that requires technical knowledge to understand. This constraint overrides
  any urge to be clever.
- Subscription business: pay quarterly for indicator access + a private Telegram group
  per market + a weekly live webinar. Run by **Robin Ho**, a Singapore trader of
  **20 years**, Principal Investment Specialist at Phillip Capital (Joseph's father and
  business partner).

## 2. THE CORRECTED TRADE LOGIC (this is the whole point — get it exactly right)

The old page showed buys happening *at* support and sells *at* resistance. **That is
wrong and must be fixed.** The real Navigator strategy:

- **Buy the rebound (support setup).** Price falls to the **support** floor and reacts.
  You do **not** buy at support. You wait for price to **rebound back up about halfway
  to the middle line** (≈50% of the distance from support to the middle), and the BUY
  label fires *there*, after the bounce is underway. Stop sits just **below** support;
  first target is the middle line, then resistance.
- **Sell the pullback (resistance setup).** Mirror image. Price rises to the
  **resistance** ceiling and reacts. You do **not** sell at resistance. You wait for
  price to **pull back down about halfway to the middle line**, and the SELL label fires
  *there*. Stop sits just **above** resistance; first target is the middle line, then
  support.
- **Catch the breakout.** Price pushes **through** a level and keeps going. You buy
  **after price closes above resistance** (a breakout), not at resistance itself. The
  mirror is a **breakdown**: you sell **after price closes below support**. Knowing the
  lines in advance is how you catch the move early instead of chasing it.

The key idea your visuals must communicate: **the Navigator waits for confirmation —
the bounce, the pullback, the break — it does not blindly catch the falling/rising
knife at the line.** This is what makes it look smart and trustworthy.

## 3. Draw REAL candlesticks (not line charts)

The old examples used thin polylines. Replace them with **proper coloured candlestick
bars** drawn as inline SVG:

- Up candle (close > open): fill + stroke `var(--up)` `#22c55e` (green).
- Down candle (close < open): fill + stroke `var(--down)` `#ef4444` (red).
- Each candle = a thin **wick** line (high→low) + a **body** rect (open→close), small
  corner radius (`rx=1.5`). Body width ~8–16px, wicks centred.
- The **channel**: support + resistance as `var(--cyan)` lines, faint translucent fill
  between them (`rgba(31,111,255,0.07)`), dashed middle line `#9fbcff`.
- Label pills sit on the chart at the moment a signal fires: green "Buy ▲" pill
  (`var(--up)`, dark text `#06280f`), red "Sell ▼" pill (`var(--down)`, white text),
  cyan "Breakout ▲" pill. Place each pill at the CORRECT point per §2 (buy pill ~halfway
  up from support, NOT at the floor; etc.).
- Mark the **entry**, **stop** and **target** on at least the lead example so the reader
  sees the full trade, not just an arrow. A reference candle generator (deterministic,
  build-time) is in `web/src/components/HeroVisual.astro` and the existing diagram in
  `web/src/pages/how-it-works.astro` — study them for the drawing idiom, but draw your
  own, accurate, prettier candles.

## 4. Structural requirements (all 5 designs must honour these)

1. **Move the trade examples up.** The three setups (buy rebound / sell pullback /
   breakout) are the most compelling part — they should appear early and prominent, not
   buried below a wall of text. You still need to establish *what the channel is* first
   (the audience needs the concept), but get to vivid, accurate examples fast.
2. **Delete the "Go deeper" section entirely.** The old page had two CTA blocks; the
   "Go deeper / Every line and label explained" section is information overload. Cut it.
   Keep **one** strong final CTA.
3. Keep and restyle the genuinely useful content: what it is (companion, not autopilot),
   the channel anatomy (3 lines), "on your chart / on your phone", and **what you get**
   (Navigator signals on ~10 top names per market → private Telegram group; Robin's own
   trades posted to the same group; a live weekly webinar, recorded).
4. **Sentence case headings.** British spelling (colour, recognise). Pricing in **SGD**
   (e.g. "$87 SGD"). Use "RHO Market Navigator" on first/marketing mention, "the
   Navigator" thereafter.

## 5. Persuasion / proof you MAY add (accurate only — no fakery)

The goal is to entice subscriptions. You may add, where it fits your design:

- A realistic **sample Telegram signal card** — a buy-zone alert showing Price, TP1,
  TP2, SL in the same structure subscribers actually receive (signals are on the
  15-minute timeframe). Use clearly **illustrative example** values and label it
  "Example signal" — never imply it is a real live call.
- A **"a week with the Navigator"** strip showing the rhythm: signals land on your phone
  through the week → Robin posts his own trades → weekly live webinar (recorded).
- **Robin's credibility**: 20 years trading full-time, Principal Investment Specialist
  at Phillip Capital, posts the trades he takes himself using the Navigator.
- Stronger final CTA framing. Buttons: **"View plans"** → `/#pricing`, and **"Get
  TradingView free"** → `/free-tradingview`. You may mention "from $87 SGD a quarter"
  (the lowest tier) as enticement — accurate.

**Forbidden:** fake testimonials, fake names, invented performance/win-rate percentages,
made-up subscriber counts, any specific real trade call presented as real. No hype words
banned by the writing rules (no "delve, robust, seamless, unlock, elevate, game-changer,
not just X but Y", no triplet-adjective padding, no em-dash spam, straight quotes only).
Write like a real person with limited time who knows trading.

## 6. Brand design system — "Deep Current" (use these tokens verbatim)

```css
:root{
  --bg:#070c18; --bg-elevated:#0a1326; --surface:#0e1729; --surface-2:#0a1120;
  --surface-nav:rgba(12,20,38,.28);
  --line:rgba(255,255,255,.08); --line-strong:rgba(255,255,255,.14);
  --ink:#ffffff; --text:#c8d4e8; --muted:#94a3c2;
  --blue:#1f6fff; --cyan:#38bdf8; --cyan-light:#7fe2ff;
  --up:#22c55e; --down:#ef4444; --warn:#ff9f0a;
  --grad-primary:linear-gradient(135deg,#1f6fff,#38bdf8);
  --grad-text:linear-gradient(100deg,#7fe2ff,#1f6fff 60%);
  --glow-blue:rgba(31,111,255,.50); --glow-cyan:rgba(56,189,248,.45);
  --shadow-card:0 18px 50px -28px rgba(0,0,0,.9);
  --shadow-btn:0 16px 38px -12px rgba(31,111,255,.75);
  --radius:14px; --radius-sm:10px; --radius-pill:999px;
  --font-sans:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;
}
```

- Font: **Plus Jakarta Sans** via Google Fonts CDN (weights 400;500;600;700;800).
- Dark theme. Navy base, electric blue + cyan accents. Optional ambient background
  glows (radial-gradients, behind everything, never on text) — see the reference file.
- The brand motif is a **compass needle** settling parallel to a rising channel
  ("a compass for the markets"). You may nod to it; don't let it dominate legibility.
- Primary button = `--grad-primary`, white text, pill, soft blue glow shadow. Ghost
  button = translucent white fill, hairline border, hover border → cyan.
- **There is a `rho-navigator-design` skill** with the full brand/UI kit — invoke it.

## 7. Output requirements

- Produce **one self-contained `.html` file** (all CSS in one `<style>` block, all SVG
  inline, only external dependency is the Google Fonts link). It must open correctly
  via `file://` with no build step. Lang `en-GB`.
- Include a minimal top nav strip (logo wordmark "RHO Navigator" + a couple of links +
  a "View plans" button) for realism, but spend your energy on the page body.
- Must be **responsive** (looks right at 1280px and at 390px mobile). Older-audience
  accessibility: visible focus states, real contrast, min 16–17px body text.
- Write your file to the EXACT path given in your dispatch prompt. Do not touch any
  other file. Do not edit the live site.
- At the end, return a short summary: your design concept in 2–3 sentences, the 3–4
  decisions you're proudest of, and anything you'd want the CEO to know when comparing.
```
