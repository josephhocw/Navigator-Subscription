# RHO Navigator — brand & design system

> ⚠️ **Superseded — not the source of truth.** The canonical brand system now lives in the **`rho-navigator-design` skill** (`.claude/skills/rho-navigator-design/` in the Playground workspace): current tokens (`colors_and_type.css`), the updated logo (the broken-ring diagonal mark), UI-kit components, and slide templates. The website ships a *synced copy* of the tokens in `web/src/styles/global.css` and the logos in `web/public/`. This document is kept for the written rationale and voice rules; where it disagrees with the skill (the old logo, "Market" in the name), **the skill wins.**

*Original design spec. Locked 2026-06-04.*

This document captured the first version of how the Navigator looks and sounds. The website was the first thing built from it; slides and the Telegram groups inherit the same tokens so everything feels like one product.

---

## 1. Brand concept

The Navigator is a compass for the markets. It reads support, resistance and trend for you, and sends clear buy and sell signals to your phone. The brand idea is exactly that: **a guide that helps you spot the turn before the crowd.**

Personality: sleek and modern, but calm and trustworthy — not loud, not hype. It should look like a serious financial tool a 20-year market veteran stands behind, while staying easy on the eye for an older, non-technical audience.

The deliberate tension we resolved: the look is full sleek fintech (dark, premium, the FXIFY / Blendr / TradingView world Joseph likes), but every choice underneath it protects legibility for buyers in their 50s–60s. Sleek and legible are not in conflict here — large type, high contrast, and clear hierarchy carry both.

### Audience

Mostly 40+, many in their late 50s to 60s, interested in trading, not very tech-savvy. Some retired, some working and trading on the side. This drives the accessibility rules in section 9 — they are not optional polish, they are core to the brand.

---

## 2. Voice

Follows Joseph's writing rules (`About Me/writing-rules.md`). In short:

- Plain English, short sentences. No jargon — no "webhook", "API", "Pine Script". Use a real-world comparison when a technical idea has to be explained.
- Warm and personal, like Joseph or Robin wrote it. Not corporate.
- British spelling (organise, colour, recognise).
- Headings in sentence case, not Title Case.
- Pricing in SGD, shown with the label, e.g. `$89 SGD`.
- Call it "the Navigator" to existing subscribers; "RHO Navigator" in first-touch and marketing copy.
- Lead the pitch with the free TradingView (via Pepperstone) — it removes a real cost of using the Navigator.

Sample headline voice: "Spot the turn before the crowd." Sub: "A TradingView indicator that reads support, resistance and trend for you — and a private group that sends the buy and sell signals straight to your phone."

---

## 3. Logo

### The mark

A compass needle inside a ring, with three candlesticks sitting subtly behind it. The compass says "Navigator"; the candlesticks say "markets". The needle is the hero; the candlesticks are a quiet supporting detail (about 45% opacity).

Construction:
- **Needle** — a four-point diamond. North half is the bright cyan gradient (`#7fe2ff` → `#1f6fff`); south half is deep navy (`#26467a` / `#1c3a6a`). This gives the spin and depth.
- **Ring** — thin circle, stroke `#2a4d80`, with a short bright-cyan locator arc (`#38bdf8`) offset near the top, like a "you are here" tick.
- **Hub** — small dark centre dot ringed in cyan (`#7fe2ff`).
- **Candlesticks** — three vertical bars with wicks behind the needle, muted blues (`#3a6db5` / `#4f86d6`) at ~45% opacity.

### Wordmark lockup

`RHO` in 800 weight white, followed by `Navigator` in 600 weight muted blue-grey (`#8fa3c4`), set in Plus Jakarta Sans. Horizontal lockup: mark + wordmark. The short form "RHO Navigator" is allowed in tight spaces.

### Variations to produce

1. Full colour lockup (mark + wordmark) — primary, on dark.
2. Mark only — for the favicon, Telegram group avatar, slide corner, app-style icon.
3. Monochrome white — for single-colour contexts and watermarks.
4. On-light version — darker ring/needle navy for the rare light background.

### Sizing & clear space

- The full mark (with candlesticks) reads down to about 32px. Below that, drop the candlesticks and keep needle + ring — that simplified mark works to ~24px (favicon).
- Keep clear space around the logo equal to the height of the needle's hub on all sides.

### Don'ts

- Don't recolour the needle outside the palette.
- Don't add a heavy drop shadow or outer glow on the mark itself (glows belong in the background, not on the logo).
- Don't stretch, rotate, or crowd the lockup.
- Don't place the full-colour mark on a busy photo without a dark scrim behind it.

---

## 4. Colour — "Deep Current"

Navy base, electric blue accents. Defined as CSS custom properties so the site, and any future component, share one source.

```css
:root {
  /* backgrounds */
  --bg:            #070c18; /* deepest page background */
  --bg-elevated:   #0a1326; /* hero gradient top, raised areas */
  --surface:       #0e1729; /* cards, panels */
  --surface-nav:   rgba(12, 20, 38, 0.28); /* glassy nav fill */
  --line:          rgba(255, 255, 255, 0.08); /* hairline borders */

  /* text */
  --ink:           #ffffff; /* headings */
  --text:          #c8d4e8; /* body */
  --muted:         #94a3c2; /* secondary, captions */
  --wordmark-mute: #8fa3c4; /* "Navigator" in the lockup */

  /* accents */
  --blue:          #1f6fff; /* primary accent */
  --cyan:          #38bdf8; /* secondary accent */
  --cyan-light:    #7fe2ff; /* highlights, locator arc, hub */

  /* logo navy tones */
  --ring:          #2a4d80;
  --needle-south:  #26467a;
  --needle-deep:   #1c3a6a;

  /* semantic (markets) */
  --up:            #22c55e;
  --down:          #ef4444;

  /* gradients */
  --grad-primary:  linear-gradient(135deg, #1f6fff, #38bdf8); /* buttons, accents */
  --grad-text:     linear-gradient(100deg, #7fe2ff, #1f6fff 60%); /* highlighted headline words */

  /* glows */
  --glow-blue:     rgba(31, 111, 255, 0.50);
  --glow-cyan:     rgba(56, 189, 248, 0.45);

  --radius:        14px;
}
```

Usage:
- Page is `--bg`. Cards and panels are `--surface` with a `--line` border.
- Headlines `--ink`; body `--text` (never below `--muted` for anything a buyer must read).
- Primary actions use `--grad-primary` with a soft blue glow shadow. One highlighted phrase per headline may use `--grad-text`.
- `--up` / `--down` only for market direction, and never as the only signal (pair with +/− or an arrow — see section 9).

Contrast: `--text` (#c8d4e8) on `--bg` (#070c18) clears WCAG AA for body text. Keep it that way — don't drop body copy to `--muted` on the darkest background.

---

## 5. Typography

**Plus Jakarta Sans** for everything — one family, warm and slightly rounded, very legible. Load weights 400, 500, 600, 700, 800 from Google Fonts.

```html
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
```

Scale (clamps keep it responsive):

| Role | Weight | Size | Tracking / leading |
|---|---|---|---|
| Display / H1 | 800 | `clamp(2.6rem, 5.4vw, 3.6rem)` | -0.025em / 1.03 |
| H2 | 800 | `clamp(2rem, 4.4vw, 3rem)` | -0.02em / 1.06 |
| H3 | 700 | `clamp(1.3rem, 2vw, 1.6rem)` | -0.01em / 1.2 |
| H4 | 700 | 1.05rem | normal / 1.3 |
| Body | 400 / 500 | 1.0–1.05rem (16–17px floor) | 1.55–1.6 |
| Eyebrow / label | 700 | 0.7rem, uppercase | 1.4px |
| Price amount | 800 | 2.3–2.4rem | -0.02em |

Rules:
- Body text never below 16px. Prefer 17px in long copy. This is an accessibility line, not a preference.
- One 800 display weight per view as the focal point; don't make everything bold.
- Numbers (prices, savings) carry weight — set price amounts at 800 so they read as the hero of a pricing card.

---

## 6. Components

### Navigation

Glassy and translucent, floating over the hero — not a solid bar. Fill `--surface-nav` with `backdrop-filter: blur(14px)` and a `--line` bottom border. The background glow shows through it. On scroll past the hero, raise opacity (toward `rgba(7,12,24,0.9)`) for legibility over content. Links in `--text` going to `--ink` on hover; primary "View plans" button on the right.

### Buttons

- **Primary** — pill, `--grad-primary` fill, white text, soft blue glow shadow (`0 16px 38px -12px var(--glow-blue)`). Lifts 2px on hover.
- **Secondary / ghost** — pill, translucent white fill (`rgba(255,255,255,0.06)`), 1px white-22% border, white text. Border goes cyan on hover.
- Generous padding (≈14px × 26px) so they're easy targets. Minimum 44px tall.

### Cards & panels

`--surface` background, 1px `--line` border, `--radius` corners. Hover lifts 4px and warms the border to cyan-40%. Featured / best-value card uses a gradient border (`--grad-primary`, cyan → blue) and a soft glow instead of a flat border.

### Pricing card

Plan name (H4), short market description (`--muted`), price (currency `--ink`, amount 800, "/mo" `--muted`), quarterly line, optional green "save" pill, plain check-list of inclusions, full-width primary button. Tabbed groups: single / combo / all markets.

### Market chips

Glass pills (`rgba(12,20,38,0.4)` + blur, `--line` border) with a small green status dot, one per market (HK / SG / US / FXMC). Can sit as a row in the nav area or float near the bottom of the hero.

### Glows & depth (the "fintech" texture)

The premium feel comes from layered background effects, kept off the content:
- Two or three radial-gradient glows in `--blue` / `--cyan` placed off-centre (top-right, mid-right).
- A faint square grid (`rgba(255,255,255,0.025)`, ~46px) masked to fade out toward the edges.
- A thin vertical light beam with a soft blue shadow, like the inspiration shots.

---

## 7. Hero & motion

The hero is full-bleed — it is the page background, not a boxed section. Layered glows + depth grid + light beam over the `--bg-elevated` → `--bg` gradient. The translucent nav floats on top. Headline and CTAs sit left; a dedicated zone on the right (or the whole background) hosts a 3D / motion element.

**3D / motion element (Joseph adds later).** A reserved slot in the hero. Likely a slowly rotating compass, globe, or radar tied to the logo. Guidance for whatever goes in:
- Keep it in the brand palette; let it bleed off-edge for depth.
- Slow, ambient motion only (gentle rotation, float, or scroll parallax) — nothing that competes with reading the headline.
- **Must respect `prefers-reduced-motion`** — fall back to a static render. This matters for an older audience.
- Until the 3D piece exists, a lightweight CSS fallback (the compass mark with rotating locator arc and a couple of pulsing blips) holds the slot. The current site already has a radar SVG that can serve as that fallback.

General motion: short, soft transitions (120–180ms) on hover/lift. Background glows may breathe slowly. No aggressive parallax or autoplay that hijacks scroll.

---

## 8. Applying it across surfaces

**Website** — as specced above. First implementation target. Migrate the existing demo from Inter + ad-hoc blues to Plus Jakarta Sans + the locked tokens, and replace the current purple logo with the new mark.

**Slides (Google Slides)** — dark `--bg` background, Plus Jakarta Sans throughout, cyan accents, the mark in a top corner. Use `--grad-text` only on the one phrase you want to pop per slide. Section dividers can use a full glow background like the hero.

**Telegram** — the mark-only logo as each group's avatar. When formatting pinned posts, lead with the cyan accent colour in any banner images so the groups feel part of the same brand.

**Email (Resend templates)** — keep emails plain and warm per the writing rules, but a small logo mark in the header and a single blue accent button tie them to the brand. Don't carry the dark hero treatment into email bodies — light, readable email beats on-brand-but-hard-to-read.

---

## 9. Accessibility (core, not optional)

The audience is older and non-technical. These rules protect the "legible" half of "sleek but legible":

- Body text ≥ 16px, ideally 17px. Headlines large.
- Maintain WCAG AA contrast for all body copy (`--text` on `--bg` passes; don't go lighter/greyer for running text).
- Tap/click targets ≥ 44px.
- Never signal market direction by colour alone — pair `--up`/`--down` with a + / − or an arrow, so it reads for colour-blind users and prints in mono.
- Honour `prefers-reduced-motion` everywhere, including the future 3D element.
- Clear focus states on links, buttons and form fields.

---

## 10. Implementation notes

- Drop the `:root` block from section 4 into the stylesheet as the token source; refactor existing hard-coded colours to the variables.
- Swap the font link to Plus Jakarta Sans; remove Inter.
- Produce the logo as SVG (scales cleanly, recolours via the palette) plus exported PNGs for Telegram and favicon.
- Existing site structure (nav, hero, showcase, free-TradingView, webinars, pricing tabs, FAQ, CTA, footer) stays; this is a reskin to the new system plus the immersive hero, not an information-architecture change.
- Mockups from the brainstorming session live in `.superpowers/brainstorm/` (gitignored) for reference: `hero-v2.html` is the agreed hero direction; `logo-refine.html` shows the chosen logo (option A).

---

## Open / deferred

- The actual 3D / motion asset — Joseph builds or sources it later; the hero reserves the slot.
- Exact final logo SVG (pixel-tuned proportions) to be produced at implementation.
- Whether to also store this brand reference in `Navigator Business Resources/` for the slides workflow — decide when slides work starts.
