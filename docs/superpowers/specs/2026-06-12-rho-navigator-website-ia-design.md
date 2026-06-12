# RHO Navigator website — information architecture & content design

*Spec written 2026-06-12. Status: draft for Joseph's review. Companion to the brand spec `2026-06-04-rho-navigator-brand-design-system.md` (Deep Current) and the five Product Knowledge docs in `../../../../Navigator Business Resources/Product Knowledge/`.*

This spec covers the **structure and content** of the marketing site (the Astro app under `web/`), not visual design (that's the brand spec) or the Stripe webhook back office (that's `CLAUDE.md` + `README-webhook.md`). It does not change any payment, webhook, or bot code.

---

## 1. Goal & audience

The site's primary job is to **convert and onboard** a mostly *warm* audience — people who've seen Robin's preview session/webinar or are already in a Telegram group. The preview covers **breadth, not depth**, so the website is where someone goes to **go deeper** on whatever caught their interest, then subscribe and get set up. A handful of those depth pages double as a **public front door** for cold traffic (search, word of mouth).

Audience profile (from `About Me/about-me.md`): mostly 50s–60s, not especially tech-savvy. So: plain English, large legible type, step-by-step where there's an action, no jargon. Accessibility is core (per the Deep Current brand non-negotiables).

**Everything is public for now.** A logged-in members area + database is a **future** project (not in this scope). The site is structured so the education/mastery content (the "Learn" section) is self-contained and can move behind a login later with minimal rework.

## 2. Information architecture

### Top navigation

`◇ RHO Navigator` · **How it works** · **Free TradingView** · **Pricing** · **Guides** · **Learn** — with a primary **View plans** button. "Manage subscription" (billing portal) moves to the footer.

Notes:
- "Free TradingView" (not "Why Pepperstone") leads the broker page with the *benefit*, not the broker name — it's the strongest hook and softer than naming an unfamiliar broker in the nav. The page still covers why-Pepperstone and safety.
- No numbers in the nav. The numbered path lives only inside the Guides page.

### Page map

| Page | In nav | Job | Public/gated | Source doc(s) |
|---|---|---|---|---|
| Home | (logo) | The pitch, trimmed | Public | `navigator-product.md` |
| How it works | ✓ | Understand it well enough to want it | Public | `navigator-product.md`, `navigator-features.md` (overview) |
| Free TradingView | ✓ | The headline perk + the safety objection-handler | Public | `pepperstone-explainer.md` |
| Pricing | ✓ | Convert; the two-price mechanic | Public | `business-model.md` |
| Guides | ✓ | Get set up — 6-step vertical timeline | Public | `onboarding-and-setup.md` |
| Learn | ✓ | Master it | Public now, **gate-ready** | `navigator-features.md`, `navigator-strategies.md` |
| FAQ | footer | Full Q&A | Public | `navigator-faq.md` |
| Terms | footer | Legal/disclaimer | Public | (exists) |

## 3. Per-page content

### Home (lean, conversion-first)

Mostly built already; the change is **trimming** so depth lives on the dedicated pages.

- **Hero** — "Spot the turn before the crowd" + live-demo visual, **with its CTA buttons kept as they are now** (primary "View plans" + secondary "See how it works"). *Keep.*
- **Showcase** (live demo / annotated / how-it-works tabs). *Keep* — this is the home's "how it works" teaser; deep version links to /how-it-works.
- **Weekly webinars + social proof** (Robin, 20 years). *Keep, trim.*
- **Free TradingView** — compact teaser → links to /free-tradingview.
- **Pricing** — compact teaser: standard prices + "Trading with us? Pay less → See pricing". *Not* the full toggle/modal (that's on /pricing).
- **FAQ** — 5 top questions → link to full /faq.
- **Final CTA.**

### How it works (pre-sale depth)

- What the Navigator is — a companion, not an auto-trader.
- How the channel works — support, resistance, breakouts, with chart visuals.
- What you get — the two signal types + weekly webinars.
- A quick tour of the labels & panels → "go deeper in Learn".

### Free TradingView (the objection-handler)

This is the biggest conversion barrier (Singaporeans wary of an unfamiliar, non-MAS broker), so it gets its own page.

- **Free TradingView** — the headline perk and how to get it (open + fund + one trade). The 3 plan tiers + redeem/renew thresholds.
- Why Pepperstone pairs with the Navigator — live data, same price feed as our signals, one platform.
- **"Is it safe?"** — MAS/regulation, segregated client funds, withdrawals, CFD/leverage basics.
- Pepperstone credibility — 15 years, 830k+ clients, EY-audited, Tier-1 regulators.

### Pricing — see §4 for the mechanic.

### Guides (setup — vertical timeline)

A vertical-timeline stepper; each step is its own guide page with full click-by-click + screenshots. Steps:

1. Open Pepperstone + free TradingView
2. Set up TradingView & Telegram
3. Subscribe to your markets
4. Connect Pepperstone to TradingView
5. Attach the Navigator
6. Trade & set alerts

(The existing two stub guides become steps 1 and 5; four new step pages are added. Exact step grouping can flex during build.)

### Learn (mastery — public now, gate-ready)

A self-contained section so it can move behind a login later. Four areas:

- **Understanding the Navigator** — every line, label, and panel.
- **Trading strategies** — the buy/sell scenarios + tips.
- **3 advanced lessons** — parallel lines, secondary trends, multi-timeframe.
- **Reading the Telegram signals.**

### FAQ (footer) & Terms (exists)

Full FAQ page fed by `navigator-faq.md`; the home FAQ teaser links here.

### Footer / utility

Manage subscription (billing portal), Full FAQ, Terms, Contact (Telegram).

## 4. The pricing mechanic

### Two prices, one switch

- A **toggle** flips every plan card between **Standard price** and the lower **Pepperstone price**. Default shows **Standard** (honest default; the toggle reveals the discount). Cards show the standard price struck through above the Pepperstone price when toggled.
- Prices (per `business-model.md`, 2026 lineup): SG 36→29, US/HK/FXMC 56→49, combos 99→89, All Markets 139→129 ($/mo; billed quarterly ×3).

### Unlocking the Pepperstone price (soft self-confirm)

Choosing a Pepperstone-priced plan opens a **confirmation modal** before checkout:

- **The single requirement:** *opened a Pepperstone account through our referral link (under RHO).* That's it.
- **This is a self-confirmation, not a hard check.** It matches the current model — the discount is delivered by two **public reusable Stripe promo codes** (`NAV21` singles, `NAV30` combos + All Markets), self-applied at checkout, scoped per tier. The modal is an honest nudge, not verification; the small accepted leakage is the same one `business-model.md` already documents. Real verification (checking IB records) needs the future login + database.
- **On "Yes, I qualify"** → the discounted checkout opens with the tier's promo code applied (via the payment link with the code pre-filled). **On "Not yet"** → point them to open Pepperstone first (→ Guides step 1) or continue at the standard price.

> **Do not conflate with the TradingView promo.** The Pepperstone *price* needs only an account opened under us. The free 3-month *TradingView plan* is separate and needs open **+ funds + one trade** — that lives on the Free TradingView page, not in this modal.

### Where it lives (split)

- **Full mechanic** (toggle + modal + a short "how to qualify" explainer) on the dedicated **/pricing** page.
- **Home** carries a compact teaser only (standard price + "Pay less → See pricing"), keeping the home page light and the interactive logic in one place.

## 5. Content sourcing map

Each of the five Product Knowledge docs has a clear destination, so nothing is orphaned:

- `navigator-product.md` → Home + How it works.
- `navigator-features.md` → How it works (overview) + Learn (full).
- `navigator-strategies.md` → Learn.
- `onboarding-and-setup.md` → Guides (the 6 steps).
- `pepperstone-explainer.md` → Free TradingView.
- `navigator-faq.md` → FAQ + home teaser.
- `business-model.md` → Pricing (numbers + the two-tier discount).

The docs are the written source; web copy is adapted from them (plainer, shorter, run through `/humanizer` for any client-facing marketing copy per the workstation editorial rules).

## 6. Design system & build

- **Brand:** Deep Current — tokens and components already in `web/src/styles/global.css` and `web/src/components/`. Reuse the existing nav, footer, hero, buttons, and the established section/card patterns. Honour the brand non-negotiables (body ≥16px, AA contrast, ≥44px tap targets, reduced-motion, market direction never by colour alone).
- **Stack:** Astro (existing). Guides and Learn articles authored as Markdown content collections (the `guides` collection already exists; add a `learn` collection on the same pattern). Pricing toggle + modal are small client-side islands.
- **Build scope:**
  - *Existing, to adjust:* Home (trim), Guides hub (rebuild as vertical timeline), the 2 guide stubs (fill in from `onboarding-and-setup.md`), Nav (relabel "Why Pepperstone"→"Free TradingView"; add Learn), Footer (add Manage subscription/FAQ).
  - *New pages:* /how-it-works, /free-tradingview, /pricing (with toggle + modal), /learn hub + Learn articles, /faq, and 4 additional guide step pages.

## 7. Out of scope (future)

- Logged-in members area + subscriber database (the reason Learn is built self-contained).
- Hard verification of Pepperstone accounts (needs the login + IB lookup).
- Extracting deck images (chart examples, label legends, screenshots) into site assets — done later when building the pages that need them.

## 8. Open items / to reconcile

- **`business-model.md` discount trigger.** ~~It currently says the Pepperstone *price* is gated on "open + fund + first trade".~~ **Resolved 2026-06-12** — `business-model.md` corrected so the Pepperstone *price* needs only an account opened under our link, with the open + fund + trade milestone kept as the separate TradingView-promo trigger. `pepperstone-explainer.md` checked — it only described the TV promo, so no change was needed.
- Default toggle state (Standard vs Pepperstone) — set to Standard here; easy to flip.
- Exact grouping of the 6 guide steps and the Learn article list — finalise during build.
