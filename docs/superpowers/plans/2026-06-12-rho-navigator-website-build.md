# RHO Navigator website build — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build out the RHO Navigator marketing site (Astro app under `web/`) to the sectioned structure in the IA spec — dedicated depth pages, a numbered Guides timeline, a Learn section, and the two-price Pepperstone pricing mechanic — keeping the home page lean.

**Architecture:** Static Astro 5 site, no framework. Pages compose a shared `Base` layout + section markup that consumes the Deep Current tokens in `global.css`. Reusable content (guides, learn) lives in Markdown content collections. Interactivity (nav menu, tabs, FAQ, the new pricing toggle/modal) is plain `<script>` islands, matching the existing codebase. Plan pricing data is centralised in one module so Home and /pricing stay in sync.

**Tech stack:** Astro 5.6, Markdown content collections (`astro:content` glob loader), vanilla TS/JS islands, CSS custom properties (Deep Current). Stripe Payment Links with `prefilled_promo_code` for the discount.

**Spec:** `docs/superpowers/specs/2026-06-12-rho-navigator-website-ia-design.md`. **Content source:** the five docs in `../../../Navigator Business Resources/Product Knowledge/` (this repo is nested in that workspace; the docs are one level up and out of this repo).

---

## Conventions for every task

- **Working directory:** all `npm`/`astro` commands run from `web/` (the Astro app root).
- **Verify command (the project's "test"):** `npm run build`. Expected: completes with `0 errors`, all routes emitted. There is no unit-test runner; for islands, also `npm run dev` and check the behaviour in the browser per the task's checklist.
- **Commit style:** conventional prefix (`feat:`, `content:`, `refactor:`). End every commit message with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Branch:** work on the existing `redesign` branch.
- **Editorial rule (content tasks):** all client-facing copy is adapted from the source doc into plain English for a 50s–60s audience, British spelling, then run through the `/humanizer` skill and shown to Joseph before it's considered done. Page *structure* is specified here; final *prose* is authored at execution under that review. This is by design, not a placeholder.

---

## File structure

**Create:**
- `web/src/pages/how-it-works.astro` — product + how-the-channel-works + features overview (pre-sale depth).
- `web/src/pages/free-tradingview.astro` — the perk + why-Pepperstone + safety FAQ (objection-handler).
- `web/src/pages/pricing.astro` — full two-price mechanic (toggle + modal).
- `web/src/pages/learn/index.astro` — Learn hub.
- `web/src/pages/learn/[...slug].astro` — Learn article renderer.
- `web/src/pages/faq.astro` — full FAQ.
- `web/src/data/plans.ts` — single source of plan display data + checkout-URL helper.
- `web/src/components/PriceToggle.astro` — the pricing cards + toggle + modal markup (used by /pricing).
- `web/src/content/learn/*.md` — Learn articles (features, strategies, lessons, signals).
- `web/src/content/guides/*.md` — 4 new guide steps (2 already exist).

**Modify:**
- `web/src/components/Nav.astro` — relabel + add Learn; drop "Manage subscription" (lives in footer).
- `web/src/components/Footer.astro` — point "Explore" links at the new dedicated pages.
- `web/src/content.config.ts` — add the `learn` collection.
- `web/src/pages/guides/index.astro` — rebuild as the vertical-timeline stepper.
- `web/src/pages/index.astro` — trim Home (pricing → compact teaser; free-TV + FAQ → teasers linking out).
- `web/src/styles/global.css` — add styles for the timeline, the price toggle/modal, and any new section patterns.

**Phases (each independently shippable):**
1. Foundation & navigation — routes exist, nav/footer wired, site builds with no 404s.
2. Pricing mechanic — /pricing with the toggle + modal + centralised plan data.
3. Guides — vertical-timeline hub + the 6 step pages.
4. Learn — collection + hub + articles.
5. Content pages + Home trim — How it works, Free TradingView, FAQ, and the lean Home.

---

## Phase 1 — Foundation & navigation

Goal: every nav destination resolves, the site builds, nothing 404s. Pages are on-brand stubs filled in later phases.

### Task 1.1: Relabel the nav and add Learn

**Files:** Modify `web/src/components/Nav.astro`

- [ ] **Step 1: Replace the `nav-links` block.** In `Nav.astro`, replace the `<div class="nav-links" id="navLinks">…</div>` contents with dedicated-page links (drop "Manage subscription" — it stays in the footer):

```astro
<div class="nav-links" id="navLinks">
  <a href="/how-it-works">How it works</a>
  <a href="/free-tradingview">Free TradingView</a>
  <a href="/pricing">Pricing</a>
  <a href="/guides">Guides</a>
  <a href="/learn">Learn</a>
</div>
```

Also update the `nav-cta` button `href="/#pricing"` → `href="/pricing"`. Remove the now-unused `BILLING_PORTAL` import line in the frontmatter if present.

- [ ] **Step 2: Build.** Run `npm run build`. Expected: `0 errors` (the link targets are created in Task 1.2; build won't fail on missing pages, but do Task 1.2 before opening the site).

- [ ] **Step 3: Commit.**
```bash
git add src/components/Nav.astro
git commit -m "feat(nav): switch to dedicated-page nav, add Learn"
```

### Task 1.2: Create the dedicated-page stubs

**Files:** Create `web/src/pages/how-it-works.astro`, `free-tradingview.astro`, `pricing.astro`, `learn/index.astro`, `faq.astro`

- [ ] **Step 1: Create each stub** using the established `page-hero` pattern (see `terms.astro`). Example — `how-it-works.astro`:

```astro
---
import Base from '../layouts/Base.astro';
---
<Base title="How it works — RHO Navigator" description="How the RHO Navigator reads support, resistance and trend, and what you get as a subscriber.">
  <section class="page-hero">
    <div class="container">
      <span class="eyebrow">The indicator</span>
      <h1>How it works</h1>
      <p>Coming together — full walkthrough of the channel, the labels and what you get.</p>
    </div>
  </section>
</Base>
```

Repeat for `free-tradingview.astro` (title "Free TradingView — RHO Navigator", eyebrow "Your TradingView, free"), `pricing.astro` (title "Pricing — RHO Navigator", eyebrow "Pricing"), `learn/index.astro` (title "Learn — RHO Navigator", eyebrow "Learn"; note the `../../layouts/Base.astro` path from the `learn/` subfolder), and `faq.astro` (title "FAQ — RHO Navigator", eyebrow "FAQ").

- [ ] **Step 2: Build + preview.** Run `npm run build`; expected `0 errors`. Then `npm run dev`, click every nav link — all five resolve, none 404.

- [ ] **Step 3: Commit.**
```bash
git add src/pages/how-it-works.astro src/pages/free-tradingview.astro src/pages/pricing.astro src/pages/learn/index.astro src/pages/faq.astro
git commit -m "feat(pages): add dedicated-page stubs for nav destinations"
```

### Task 1.3: Add the `learn` content collection

**Files:** Modify `web/src/content.config.ts`

- [ ] **Step 1: Add the collection.** After the `guides` definition, add a `learn` collection (same shape; `category` groups articles on the hub):

```ts
const learn = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/learn' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number().default(99),
    category: z.enum(['understand', 'strategies', 'lessons', 'signals']).default('understand'),
  }),
});

export const collections = { guides, learn };
```

- [ ] **Step 2: Create the folder with a placeholder** so the glob resolves: create `web/src/content/learn/.gitkeep` (empty). Real articles arrive in Phase 4.

- [ ] **Step 3: Build.** `npm run build`; expected `0 errors`.

- [ ] **Step 4: Commit.**
```bash
git add src/content.config.ts src/content/learn/.gitkeep
git commit -m "feat(content): add learn collection"
```

### Task 1.4: Point the footer at the dedicated pages

**Files:** Modify `web/src/components/Footer.astro`

- [ ] **Step 1: Update the "Explore" list** so links go to pages, not home anchors, and add Learn:

```astro
<li><a href="/how-it-works">How it works</a></li>
<li><a href="/free-tradingview">Free TradingView</a></li>
<li><a href="/guides">Guides</a></li>
<li><a href="/learn">Learn</a></li>
<li><a href="/pricing">Pricing</a></li>
<li><a href="/faq">FAQ</a></li>
```

Leave the "Markets" and "Contact" columns as-is ("Manage subscription" already lives in Contact).

- [ ] **Step 2: Build + commit.**
```bash
npm run build   # 0 errors
git add src/components/Footer.astro
git commit -m "feat(footer): link explore items to dedicated pages"
```

---

## Phase 2 — Pricing mechanic

Goal: a working /pricing page with the Standard ⇄ Pepperstone toggle, the soft-confirm modal, and the discount applied via the payment link's promo code. Plan data centralised so Home (Phase 5) reuses it.

### Task 2.1: Centralise plan data

**Files:** Create `web/src/data/plans.ts`

- [ ] **Step 1: Write the data module.** Prices from `business-model.md` (2026 lineup). Payment links are the existing ones from `index.astro`. Singles use `NAV21`, combos + All Markets use `NAV30`.

```ts
export type PlanTier = 'single' | 'combo' | 'all';

export interface Plan {
  code: string;
  name: string;
  desc: string;
  tier: PlanTier;
  listMonthly: number;
  listQuarterly: number;
  pepMonthly: number;
  pepQuarterly: number;
  features: string[];
  link: string;
  promoCode: 'NAV21' | 'NAV30';
}

export const PLANS: Plan[] = [
  { code: 'SG',   name: 'SG',   tier: 'single', desc: 'Singapore stocks, futures & indices',
    listMonthly: 36, listQuarterly: 108, pepMonthly: 29, pepQuarterly: 87,
    features: ['All SG stocks, futures & indices', 'Private SG signal group', '~10 large-cap signals'],
    link: 'https://buy.stripe.com/5kQ00lb123X5f6Bb044ow05', promoCode: 'NAV21' },
  { code: 'US',   name: 'US',   tier: 'single', desc: 'US stocks, futures, indices + DAX 40 & Nikkei 225',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All US stocks, futures & indices', 'Bonus: DAX 40 & Nikkei 225', 'Private US signal group'],
    link: 'https://buy.stripe.com/8x24gB6KM65de2x9W04ow06', promoCode: 'NAV21' },
  { code: 'HK',   name: 'HK',   tier: 'single', desc: 'Hong Kong stocks, futures & indices',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All HK stocks, futures & indices', 'Private HK signal group', '~10 large-cap signals'],
    link: 'https://buy.stripe.com/3cI9AV2uw3X53nT9W04ow08', promoCode: 'NAV21' },
  { code: 'FXMC', name: 'FXMC', tier: 'single', desc: 'Forex, Crypto & Metals (Gold & Silver)',
    listMonthly: 56, listQuarterly: 168, pepMonthly: 49, pepQuarterly: 147,
    features: ['All forex pairs', 'All major cryptocurrencies', 'Gold & Silver'],
    link: 'https://buy.stripe.com/9B6eVfb120KT7E9gko4ow01', promoCode: 'NAV21' },
  { code: 'US_HK', name: 'US + HK', tier: 'combo', desc: 'Major markets bundle + SG free',
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['US + HK: all stocks, futures & indices', 'Singapore market FREE', '3 signal groups'],
    link: 'https://buy.stripe.com/5kQ9AVfhi1OXf6Bfgk4ow03', promoCode: 'NAV30' },
  { code: 'US_FXMC', name: 'US + FXMC', tier: 'combo', desc: 'Diversification bundle + SG free',
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['US: all stocks, futures & indices', 'FXMC: forex, crypto + Gold/Silver', 'Singapore market FREE'],
    link: 'https://buy.stripe.com/28EbJ3c56ctB5w10lq4ow04', promoCode: 'NAV30' },
  { code: 'HK_FXMC', name: 'HK + FXMC', tier: 'combo', desc: 'Asia & global assets + SG free',
    listMonthly: 99, listQuarterly: 297, pepMonthly: 89, pepQuarterly: 267,
    features: ['HK: all stocks, futures & indices', 'FXMC: forex, crypto + Gold/Silver', 'Singapore market FREE'],
    link: 'https://buy.stripe.com/5kQbJ31qseBJ6A5ecg4ow09', promoCode: 'NAV30' },
  { code: 'ALL', name: 'All Markets', tier: 'all', desc: 'US + HK + SG + FXMC — everything',
    listMonthly: 139, listQuarterly: 417, pepMonthly: 129, pepQuarterly: 387,
    features: ['US, HK, SG — all stocks, futures & indices', 'FXMC: forex, crypto + Gold/Silver', 'All 4 signal groups'],
    link: 'https://buy.stripe.com/bJecN74CE65d5w17NS4ow07', promoCode: 'NAV30' },
];

export type PriceMode = 'standard' | 'pepperstone';

/** Checkout URL; in pepperstone mode the tier's promo code is pre-filled at Stripe checkout. */
export function checkoutUrl(plan: Plan, mode: PriceMode): string {
  return mode === 'pepperstone'
    ? `${plan.link}?prefilled_promo_code=${plan.promoCode}`
    : plan.link;
}
```

- [ ] **Step 2: Build + commit.**
```bash
npm run build   # 0 errors
git add src/data/plans.ts
git commit -m "feat(pricing): centralise plan data + checkout-url helper"
```

> `checkoutUrl` is pure — if a test runner is added later, it's the unit to cover (standard → bare link; pepperstone → link + `?prefilled_promo_code=NAV21|NAV30`). Not adding a runner now (YAGNI; the repo has none).

### Task 2.2: Build the pricing cards + toggle + modal

**Files:** Create `web/src/components/PriceToggle.astro`; modify `web/src/pages/pricing.astro`, `web/src/styles/global.css`

- [ ] **Step 1: Write `PriceToggle.astro`.** Render category tabs (reuse `.ptab`/`.plans` pattern from `index.astro`), the Standard/Pepperstone toggle, the plan cards (both prices rendered; CSS shows the active one via a `data-mode` attribute on a wrapper), and one shared modal. Each Subscribe button carries `data-link`, `data-promo`, and `data-name` so the island can build the URL and fill the modal.

```astro
---
import { PLANS } from '../data/plans.ts';
const cats = [
  { key: 'single', label: 'Single markets' },
  { key: 'combo', label: 'Combo plans' },
  { key: 'all', label: 'All markets' },
];
---
<div class="pricing-wrap" data-mode="standard">
  <div class="price-toggle" role="tablist" aria-label="Price mode">
    <button class="pt-mode on" data-mode="standard">Standard price</button>
    <button class="pt-mode" data-mode="pepperstone">Pepperstone price <span class="pt-save">save up to $30/qtr</span></button>
  </div>
  <p class="pt-sub" data-when="standard">The standard price. Trading with us through Pepperstone? Switch to the Pepperstone price.</p>
  <p class="pt-sub" data-when="pepperstone">The lower price for clients with a Pepperstone account opened under our link.</p>

  <div class="ptabs">
    {cats.map((c, i) => <button class={`ptab ${i === 0 ? 'on' : ''}`} data-cat={c.key}>{c.label}</button>)}
  </div>

  {cats.map((c, i) => (
    <div class={`plans ${i === 0 ? 'on' : ''}`} data-cat={c.key}>
      {PLANS.filter((p) => p.tier === c.key).map((p) => (
        <div class={`plan ${p.code === 'ALL' ? 'featured' : ''}`}>
          <div class="pname">{p.name}</div>
          <div class="pdesc">{p.desc}</div>
          <div class="was" data-show="pepperstone">${p.listMonthly}/mo</div>
          <div class="price">
            <span class="cur">$</span>
            <span class="amt" data-standard={p.listMonthly} data-pepperstone={p.pepMonthly}>{p.listMonthly}</span>
            <span class="per">SGD/mo</span>
          </div>
          <div class="qtr">
            billed quarterly at
            <span data-standard={`$${p.listQuarterly} SGD`} data-pepperstone={`$${p.pepQuarterly} SGD`}>${p.listQuarterly} SGD</span>
          </div>
          <ul>{p.features.map((f) => <li><span class="ck">✓</span> {f}</li>)}</ul>
          <button class="btn btn-primary btn-block sub-btn" data-link={p.link} data-promo={p.promoCode} data-name={p.name}>Subscribe</button>
        </div>
      ))}
    </div>
  ))}

  <!-- shared confirmation modal -->
  <div class="pep-modal" id="pepModal" hidden>
    <div class="pep-backdrop" data-close></div>
    <div class="pep-card" role="dialog" aria-modal="true" aria-labelledby="pepTitle">
      <div class="pep-ey">Quick check</div>
      <h3 id="pepTitle">Unlock the Pepperstone price</h3>
      <p>This lower price is for clients who've <b>opened a Pepperstone account through our link</b>. That's the only requirement.</p>
      <p class="pep-fine">Funding and a first trade aren't needed for this price — those are for the separate free-TradingView offer.</p>
      <div class="pep-btns">
        <a class="btn btn-primary btn-block" id="pepYes" href="#">Yes, I qualify — continue</a>
        <a class="btn btn-ghost btn-block" href="/free-tradingview">Not yet — open Pepperstone first</a>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Use it on the page.** Replace `pricing.astro` body with the hero + `<PriceToggle />` + a short "how to qualify for the Pepperstone price" section (3 lines, from `business-model.md`: open an account under our link). Import: `import PriceToggle from '../components/PriceToggle.astro';`.

- [ ] **Step 3: Add styles** to `global.css` for `.price-toggle`, `.pt-mode`, `.pt-save`, `.pt-sub`, `.was`, `.pep-modal`/`.pep-card`/`.pep-backdrop`/`.pep-btns`, and the `data-mode` show/hide rules. Reuse existing `.plan`, `.ptab`, `.plans`, `.btn*` styles. Key rules:

```css
.pt-sub[data-when]{display:none} .pricing-wrap[data-mode="standard"] .pt-sub[data-when="standard"]{display:block}
.pricing-wrap[data-mode="pepperstone"] .pt-sub[data-when="pepperstone"]{display:block}
.was{display:none;text-decoration:line-through;color:var(--muted);font-size:.85rem}
.pricing-wrap[data-mode="pepperstone"] .was[data-show="pepperstone"]{display:block}
.pep-modal[hidden]{display:none}
.pep-modal{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:20px}
.pep-backdrop{position:absolute;inset:0;background:rgba(4,8,16,.72)}
.pep-card{position:relative;max-width:440px;background:var(--surface);border:1px solid var(--line-strong);border-radius:16px;padding:26px 24px}
```

- [ ] **Step 4: Build + visual check.** `npm run build` (0 errors); `npm run dev`; on /pricing confirm category tabs switch, prices look right in standard mode.

- [ ] **Step 5: Commit.**
```bash
git add src/components/PriceToggle.astro src/pages/pricing.astro src/styles/global.css
git commit -m "feat(pricing): two-price cards, toggle and confirm modal markup"
```

### Task 2.3: Wire the pricing island

**Files:** Modify `web/src/pages/pricing.astro` (add a `<script>` at the end)

- [ ] **Step 1: Add the island script.** Toggle flips `data-mode` + every price number/quarterly string; category tabs reuse the existing pattern (already global in `Base.astro`, but scope a local copy if needed); Subscribe respects the mode.

```html
<script>
  const wrap = document.querySelector<HTMLElement>('.pricing-wrap');
  if (wrap) {
    const setMode = (mode: 'standard' | 'pepperstone') => {
      wrap.dataset.mode = mode;
      wrap.querySelectorAll<HTMLElement>('.pt-mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
      wrap.querySelectorAll<HTMLElement>('[data-standard]').forEach((el) => {
        el.textContent = el.dataset[mode] ?? el.textContent;
      });
    };
    wrap.querySelectorAll<HTMLElement>('.pt-mode').forEach((b) =>
      b.addEventListener('click', () => setMode(b.dataset.mode as 'standard' | 'pepperstone')),
    );

    const modal = document.getElementById('pepModal');
    const yes = document.getElementById('pepYes') as HTMLAnchorElement | null;
    const openModal = (url: string) => { if (yes) yes.href = url; modal?.removeAttribute('hidden'); };
    const closeModal = () => modal?.setAttribute('hidden', '');
    modal?.querySelector('[data-close]')?.addEventListener('click', closeModal);

    wrap.querySelectorAll<HTMLElement>('.sub-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        const link = btn.dataset.link!;
        if (wrap.dataset.mode === 'pepperstone') {
          openModal(`${link}?prefilled_promo_code=${btn.dataset.promo}`);
        } else {
          window.location.href = link;
        }
      }),
    );
  }
</script>
```

- [ ] **Step 2: Manual verification matrix** (`npm run dev`, /pricing):
  - Standard mode → card shows list price ($36 SG), no struck price; Subscribe → goes straight to the bare payment link.
  - Toggle to Pepperstone → prices drop (SG $29), list price struck through appears, sub-line text swaps.
  - Pepperstone mode → Subscribe opens the modal; "Yes" link target is `…buy.stripe.com/…?prefilled_promo_code=NAV21` (single) or `NAV30` (combo/All); "Not yet" → /free-tradingview; backdrop closes it.
  - Category tabs still switch single/combo/all.

- [ ] **Step 3: Commit.**
```bash
git add src/pages/pricing.astro
git commit -m "feat(pricing): toggle + modal island wiring"
```

---

## Phase 3 — Guides (vertical-timeline setup path)

Goal: the Guides hub renders the 6-step vertical timeline; each step is a guide page with the full click-by-click from `onboarding-and-setup.md`.

### Task 3.1: Rebuild the Guides hub as a vertical timeline

**Files:** Modify `web/src/pages/guides/index.astro`, `web/src/styles/global.css`

- [ ] **Step 1:** Render the sorted `guides` collection as a vertical timeline (numbered badge + title + description + "Start" link) instead of the current card grid. Use `guide.data.step`/`order`. Markup pattern:

```astro
<ol class="timeline">
  {guides.map((g, i) => (
    <li class="tl-step">
      <span class="tl-badge">{i + 1}</span>
      <a class="tl-body" href={`/guides/${g.id}`}>
        <span class="tl-title">{g.data.title}</span>
        <span class="tl-desc">{g.data.description}</span>
      </a>
    </li>
  ))}
</ol>
```

- [ ] **Step 2:** Add `.timeline`, `.tl-step`, `.tl-badge`, `.tl-body`, `.tl-title`, `.tl-desc` styles to `global.css` (vertical connector line via `.tl-step:not(:last-child)::before`, badge on the gradient). Mirrors the approved mockup.
- [ ] **Step 3:** `npm run build` (0 errors); `npm run dev`, confirm the timeline renders in order. Commit `feat(guides): vertical-timeline hub`.

### Task 3.2: Author the 6 guide steps

**Files:** Modify `web/src/content/guides/open-pepperstone-free-tradingview.md` (step 1) and `set-up-navigator-tradingview.md`; create 4 new `.md` files.

The 6 steps and their `step`/`order` frontmatter + source section in `onboarding-and-setup.md`:

1. `open-pepperstone-free-tradingview.md` — step "1", order 1 — *Part A1* (open Pepperstone) + the free-TV note.
2. `tradingview-and-telegram.md` — step "2", order 2 — *A3 + A4* (TradingView account/username, Telegram username).
3. `subscribe.md` — step "3", order 3 — *Part B* (subscribe on the site).
4. `connect-pepperstone-tradingview.md` — step "4", order 4 — *A5* (connect Pepperstone to TradingView).
5. `attach-the-navigator.md` (rename target of `set-up-navigator-tradingview.md`) — step "5", order 5 — *C1/C2* (attach the indicator).
6. `trade-and-alerts.md` — step "6", order 6 — *C5–C7* (place a trade, set alerts).

- [ ] **Step 1 (repeat per file):** Create/rewrite the file with frontmatter (`title`, `description`, `step`, `order`) and author the body from the named section of `onboarding-and-setup.md`, as numbered steps with explicit click paths. Run `/humanizer` on the body; show Joseph. (Screenshots are added later — leave image slots described in a comment, don't fabricate image links.)
- [ ] **Step 2:** After each file, `npm run build` (0 errors) and check it renders at `/guides/<id>`.
- [ ] **Step 3:** Commit per file, e.g. `content(guides): step 2 — TradingView & Telegram`.

---

## Phase 4 — Learn (mastery, gate-ready)

Goal: the Learn hub groups articles by category; articles carry the education content from `navigator-features.md` and `navigator-strategies.md`. Built self-contained so it can move behind a login later (keep all routes under `/learn/**` and data in the `learn` collection — no cross-imports from marketing pages).

### Task 4.1: Learn article renderer + hub

**Files:** Create `web/src/pages/learn/[...slug].astro`; update `web/src/pages/learn/index.astro`

- [x] **Step 1:** `[...slug].astro` — `getStaticPaths()` over the `learn` collection, render `<Content />` inside the `.prose` pattern (mirror `guides/[...slug].astro`).
- [x] **Step 2:** `learn/index.astro` — list articles grouped by `category` (Understanding the Navigator / Trading strategies / Lessons / Reading signals), each a card linking to `/learn/<id>`.
- [x] **Step 3:** `npm run build` (0 errors). Commit `feat(learn): article renderer + grouped hub`.

### Task 4.2: Author the Learn articles

**Files:** Create `web/src/content/learn/*.md`

Initial set (category, source):
- `understanding-the-navigator.md` (understand, `navigator-features.md` — channels, labels, panels).
- `trading-strategies.md` (strategies, `navigator-strategies.md` — buy/sell scenarios + tips).
- `advanced-lessons.md` (lessons, `navigator-strategies.md` lessons 1–3).
- `reading-the-signals.md` (signals, `navigator-strategies.md` signals + `navigator-product.md` signal mechanics).

- [x] **Step 1 (per file):** Create with frontmatter (`title`, `description`, `order`, `category`); author the body from the source doc, plain-English, run `/humanizer`, show Joseph.
- [x] **Step 2:** `npm run build` (0 errors); check `/learn` grouping + each article route. Commit per file.

---

## Phase 5 — Content pages + Home trim

### Task 5.1: How it works page

**Files:** `web/src/pages/how-it-works.astro`
- [ ] Replace the stub with sections (from `navigator-product.md` + `navigator-features.md` overview): what it is (companion, not auto-trader); how the channel works (support/resistance/breakout) with chart visuals; what you get (2 signal types + webinars); a labels/panels teaser linking to `/learn`. Reuse `.section`/`.section-head` patterns. `/humanizer` the prose, show Joseph. Build + commit.

### Task 5.2: Free TradingView page

**Files:** `web/src/pages/free-tradingview.astro`
- [ ] Replace the stub with sections (from `pepperstone-explainer.md`): the free-TradingView perk + how to get it (open + fund + trade); why Pepperstone pairs with the Navigator; an "Is it safe?" block (MAS, segregated funds, withdrawals); credibility. Build + `/humanizer` + show Joseph + commit.

### Task 5.3: FAQ page

**Files:** `web/src/pages/faq.astro`
- [ ] Build the full FAQ from `navigator-faq.md` reusing the `.faq-item`/`.faq-q`/`.faq-a` accordion markup (the accordion script is already global in `Base.astro`). Build + commit.

### Task 5.4: Trim the Home page

**Files:** `web/src/pages/index.astro`
- [ ] **Step 1:** Replace the full `#pricing` section with a **compact teaser** — a short line + "Trading with us? Pay less" + a `View pricing` button to `/pricing`. (Reuse plan names/prices from `data/plans.ts` if showing headline numbers; keep it to a few lines, not the full grid.)
- [ ] **Step 2:** Trim `#free-tradingview` to a short teaser linking to `/free-tradingview`; trim `#faq` to 4–5 questions with a "See all questions" link to `/faq`.
- [ ] **Step 3:** Keep the hero (with its existing CTAs), showcase, and webinars. Confirm hero CTAs still read "View plans" (→ `/pricing`) + "See how it works" (→ `/how-it-works` or `#showcase`).
- [ ] **Step 4:** `npm run build` (0 errors); `npm run dev`, confirm Home is lean and every teaser links out. Commit `refactor(home): trim to lean conversion page with teasers`.

---

## Self-review

**Spec coverage:** Home trim → 5.4; How it works → 5.1; Free TradingView → 5.2; Pricing mechanic (toggle/modal/soft-confirm/auto-apply/split) → Phase 2 + 5.4 teaser; Guides vertical timeline + 6 steps → Phase 3; Learn (gate-ready) → Phase 4; FAQ → 5.3; nav labels ("Free TradingView", "Learn") → 1.1; footer/Manage subscription → 1.4 (already present). All spec sections map to a task.

**Placeholder scan:** No "TBD"/"handle edge cases". Content-authoring tasks specify the page structure + exact source section + the `/humanizer`+review gate; final prose is authored at execution by design (Joseph's editorial rules require his voice), which is stated explicitly — not a code/logic placeholder. All code steps include the actual code.

**Type/name consistency:** `Plan`, `PriceMode`, `checkoutUrl`, `PLANS` used consistently across 2.1→2.3; `data-mode`/`data-standard`/`data-pepperstone`/`.sub-btn`/`#pepModal`/`#pepYes` are the same in the markup (2.2) and the island (2.3); promo codes `NAV21` (singles) / `NAV30` (combos+All) consistent with `business-model.md`.

**Note on the pricing gate:** the modal copy uses the corrected gate — Pepperstone *price* needs only an account opened under our link; fund + trade belongs to the separate TradingView promo (called out in the modal fine print and the /free-tradingview page).
