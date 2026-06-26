// Mobile audit — programmatic checks for a single route at phone widths.
// Complements mobile-shots.mjs (which captures images). This one returns
// machine-readable findings: horizontal overflow, tiny fonts, small tap
// targets, and (with --modal) modal fit / body-scroll-lock / close affordance.
//
// Usage:
//   node mobile-audit.mjs /faq                 # audit one route, default widths
//   node mobile-audit.mjs / --modal            # also exercise the pricing modals
//   node mobile-audit.mjs /how-it-works 360    # one width
//   BASE_URL=http://localhost:4321 node mobile-audit.mjs /terms
//
// Requires the dev server running (npm run dev) at BASE.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4321';
const args = process.argv.slice(2);
const MODAL = args.includes('--modal');
const route = args.find((a) => a.startsWith('/')) || '/';
const widthArgs = args.filter((a) => /^\d+$/.test(a)).map(Number);
const WIDTHS = widthArgs.length ? widthArgs : [360, 390];

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// In-page scan. Runs in the browser; returns plain JSON.
function scan() {
  const vw = window.innerWidth;
  const out = { vw, overflow: [], smallFonts: [], smallTargets: [] };

  // Document-level horizontal overflow (scrollWidth can be clamped by
  // overflow-x:hidden on body, so we also scan element rects below).
  out.docScrollW = document.documentElement.scrollWidth;
  out.bodyScrollW = document.body.scrollWidth;
  out.hasDocOverflow = document.documentElement.scrollWidth > vw + 1;

  const seen = new Set();
  const sel = (el) => {
    if (el.id) return '#' + el.id;
    const cls = (el.className && el.className.toString().trim().split(/\s+/).slice(0, 2).join('.')) || '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const visible = (el, r) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
  };

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;

    // 1) elements bleeding past the viewport edge
    if (r.right > vw + 1 || r.left < -1) {
      const key = 'ovf:' + sel(el);
      if (!seen.has(key)) {
        seen.add(key);
        out.overflow.push({
          el: sel(el),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          overBy: Math.round(Math.max(r.right - vw, -r.left)),
        });
      }
    }

    // 2) tiny fonts on elements that directly hold text
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (hasOwnText) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs && fs < 14) {
        const key = 'fnt:' + sel(el) + ':' + fs;
        if (!seen.has(key)) {
          seen.add(key);
          out.smallFonts.push({ el: sel(el), px: Math.round(fs * 10) / 10, text: el.textContent.trim().slice(0, 40) });
        }
      }
    }

    // 3) small tap targets — standalone controls only (skip inline text links)
    const tag = el.tagName.toLowerCase();
    const isControl =
      tag === 'button' ||
      el.matches('.btn, [role="button"], .nav-toggle, .tab, .ptab, .pt-mode, .faq-q, .wstep, .wbtn, .vc-btn');
    if (isControl) {
      if (r.width < 44 || r.height < 44) {
        const key = 'tap:' + sel(el);
        if (!seen.has(key)) {
          seen.add(key);
          out.smallTargets.push({ el: sel(el), w: Math.round(r.width), h: Math.round(r.height), text: el.textContent.trim().slice(0, 24) });
        }
      }
    }
  }
  return out;
}

// Modal-specific probe for the homepage pricing modals.
async function probeModal(page, vw) {
  const report = {};
  // Open Modal B (nudge) via the first standard-mode Subscribe button.
  const subBtn = page.locator('.sub-btn').first();
  await subBtn.scrollIntoViewIfNeeded();
  await subBtn.click();
  await page.waitForTimeout(250);

  report.nudge = await page.evaluate(() => {
    const m = document.getElementById('pepNudge');
    if (!m || m.hasAttribute('hidden')) return { open: false };
    const card = m.querySelector('.pep-card');
    const cr = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const bodyScrolls = (() => {
      const before = window.scrollY;
      window.scrollBy(0, 400);
      const moved = window.scrollY !== before;
      window.scrollTo(0, before);
      return moved;
    })();
    // any visible explicit close affordance? (X button or backdrop)
    const hasXButton = !!m.querySelector('[aria-label*="close" i], .pep-close, button[data-close]');
    const hasBackdrop = !!m.querySelector('.pep-backdrop');
    return {
      open: true,
      vw: window.innerWidth,
      vh: window.innerHeight,
      cardW: Math.round(cr.width),
      cardLeft: Math.round(cr.left),
      cardRight: Math.round(cr.right),
      cardTop: Math.round(cr.top),
      cardBottom: Math.round(cr.bottom),
      cardMaxHeight: cs.maxHeight,
      cardOverflowY: cs.overflowY,
      fitsHoriz: cr.left >= 0 && cr.right <= window.innerWidth,
      fitsVert: cr.top >= 0 && cr.bottom <= window.innerHeight,
      bodyScrollLocked: !bodyScrolls,
      hasXButton,
      hasBackdrop,
    };
  });

  // Close it, then test at a short (landscape-ish) viewport for vertical fit.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.setViewportSize({ width: vw, height: 480 });
  await subBtn.scrollIntoViewIfNeeded();
  await subBtn.click();
  await page.waitForTimeout(250);
  report.shortViewport = await page.evaluate(() => {
    const m = document.getElementById('pepNudge');
    if (!m || m.hasAttribute('hidden')) return { open: false };
    const card = m.querySelector('.pep-card');
    const cr = card.getBoundingClientRect();
    return {
      vh: window.innerHeight,
      cardTop: Math.round(cr.top),
      cardBottom: Math.round(cr.bottom),
      cardHeight: Math.round(cr.height),
      topClipped: cr.top < 0,
      bottomClipped: cr.bottom > window.innerHeight,
      reachable: cr.top >= 0 && cr.bottom <= window.innerHeight,
    };
  });
  return report;
}

// Echo the resolved target to stderr so a mis-passed route (e.g. Git-Bash MSYS
// stripping the leading-slash arg, which silently falls back to "/") is obvious.
console.error(`[mobile-audit] auditing ${BASE}${route} at widths ${WIDTHS.join(', ')}${MODAL ? ' (+modal)' : ''}`);

const browser = await chromium.launch();
const results = { route, base: BASE, widths: {} };

for (const width of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  const page = await context.newPage();
  await page.goto(BASE + route, { waitUntil: 'load', timeout: 30000 });
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await page.waitForTimeout(400);

  const scanResult = await page.evaluate(scan);
  const entry = { scan: scanResult };
  if (MODAL) {
    try {
      entry.modal = await probeModal(page, width);
    } catch (e) {
      entry.modal = { error: e.message.split('\n')[0] };
    }
  }
  results.widths[width] = entry;
  await context.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
