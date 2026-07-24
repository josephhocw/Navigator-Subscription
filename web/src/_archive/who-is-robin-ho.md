# Archived section — "Who is Robin Ho" (eyebrow: *The trader behind it*)

Removed from the landing page (`src/pages/index.astro`) on **2026-07-25** at Joseph's request — may be brought back later.

It sat **between the Showcase section and the "What you get" section** (i.e. after `</section>` closing `#showcase`, before `<!-- ===== What you get ===== -->`).

## To restore

1. Paste the markup block below back into `src/pages/index.astro` at the position noted above.
2. Add `who is Robin Ho` back into the section-order comment at the top of `index.astro`.
3. The CSS is still present in `src/styles/global.css` (under `/* ---------- Who is Robin Ho ... */`) — it was left in place, so nothing to re-add there. Image asset `public/assets/robin-ho.webp` is also still in the repo.

## Markup

```astro
  <!-- ===== Who is Robin Ho ===== -->
  <section class="section" id="about-robin">
    <div class="container split2 robin-grid">
      <div class="robin-card">
        <img src="/assets/robin-ho.webp" alt="Robin Ho, Principal Investment Specialist at Phillip Capital" width="535" height="633" loading="lazy" />
        <div class="robin-id"><b>Robin Ho</b><span>Principal Investment Specialist, Phillip Capital</span></div>
      </div>
      <div class="robin-copy">
        <div class="section-head">
          <span class="eyebrow">The trader behind it</span>
          <h2>Who is <span class="hl">Robin Ho</span>?</h2>
        </div>
        <p class="sub">The Navigator is built on the way Robin reads a chart — the same method he still trades with himself, every day.</p>
        <ul class="checklist robin-facts">
          <li><span class="ck">✓</span><span>25 years trading the markets full time</span></li>
          <li><span class="ck">✓</span><span>Principal Investment Specialist at Phillip Capital</span></li>
          <li><span class="ck">✓</span><span>Seven-time winner of Phillip Capital's trading awards</span></li>
          <li><span class="ck">✓</span><span>Turned $100,000 into $2 million in 15 months during the 2008 financial crisis</span></li>
        </ul>
        <p class="robin-press">Featured in The Business Times, Zaobao and The New Paper.</p>
        <a href="https://www.robinhosmartrade.com/about/" target="_blank" rel="noopener" class="btn btn-ghost">More about Robin ↗</a>
      </div>
    </div>
  </section>
```

## CSS (kept in `global.css`, listed here for reference)

```css
/* ---------- Who is Robin Ho (credibility strip) ---------- */
.robin-grid { grid-template-columns: 0.72fr 1.28fr; gap: clamp(2.2rem, 5vw, 4.5rem); }
.robin-card {
  position: relative; max-width: 400px; overflow: hidden;
  border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-card);
  background:
    radial-gradient(130% 90% at 82% 0%, rgba(31, 111, 255, 0.22), transparent 60%),
    radial-gradient(90% 70% at 12% 100%, rgba(56, 189, 248, 0.12), transparent 55%),
    var(--surface-2);
}
.robin-card img { display: block; width: 100%; height: auto; padding: 1.5rem 1.1rem 0; filter: drop-shadow(0 16px 26px rgba(0, 0, 0, 0.5)); }
.robin-id { position: absolute; inset: auto 0 0; padding: 2.4rem 1.3rem 1.1rem; background: linear-gradient(180deg, transparent, rgba(7, 12, 24, 0.94) 62%); }
.robin-id b { display: block; color: var(--ink); font-size: 1.08rem; font-weight: 700; }
.robin-id span { color: var(--muted); font-size: 0.88rem; }
.robin-copy .sub { color: var(--muted); max-width: 52ch; margin: 1rem 0 0; }
.robin-facts { margin: 1.5rem 0 1.1rem; }
.robin-facts li { font-size: 1rem; }
.robin-press { color: var(--muted); font-size: 0.92rem; margin: 0 0 1.7rem; }

/* in the max-width:820px media query: */
.robin-card { max-width: 320px; margin: 0 auto; }
```
