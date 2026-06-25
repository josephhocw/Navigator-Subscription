// Mobile screenshot pass for responsive review.
// Loads each page in a true mobile profile (viewport + touch + mobile UA),
// triggers lazy-loaded images by scrolling, and saves a full-page PNG per
// page per width into mobile-shots/ (gitignored).
//
// Usage:
//   node mobile-shots.mjs                 # all pages, default widths, full-page
//   node mobile-shots.mjs 360             # all pages at one width
//   node mobile-shots.mjs / /faq          # only these routes, default widths
//   node mobile-shots.mjs --tiles / 390   # phone-screen tiles (readable detail)
//
// Full-page mode = one tall PNG per page (good for macro structure, but a long
// page downscales to a thumbnail). Tile mode = a series of viewport-sized PNGs
// down the page, each at full clarity — what you actually see screen by screen.
//
// Requires the dev server running (npm run dev) at BASE.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE_URL || 'http://localhost:4321';

// Common phone widths. 390 = iPhone 12/13/14 (the canonical width);
// 360 = a small/typical Android, where layouts get tightest.
const WIDTHS = { 390: 'iphone', 360: 'android' };

const PAGES = [
  ['/', 'home'],
  ['/how-it-works', 'how-it-works'],
  ['/free-tradingview', 'free-tradingview'],
  ['/faq', 'faq'],
  ['/guides', 'guides'],
  ['/guides/trading', 'guides-trading'],
  ['/guides/subscribe', 'guides-subscribe'],
  ['/terms', 'terms'],
];

// CLI args: numbers override widths, paths override the page list, --tiles switches mode.
const args = process.argv.slice(2);
const TILES = args.includes('--tiles');
const widthArgs = args.filter((a) => /^\d+$/.test(a)).map(Number);
const pathArgs = args.filter((a) => a.startsWith('/'));
const widths = widthArgs.length
  ? Object.fromEntries(widthArgs.map((w) => [w, WIDTHS[w] || `${w}px`]))
  : WIDTHS;
const pages = pathArgs.length
  ? pathArgs.map((p) => [p, p.replace(/\//g, '_').replace(/^_/, '') || 'home'])
  : PAGES;

const OUT = 'mobile-shots';

// Scroll to the bottom in steps so lazy-loaded images/sections render, then
// return to the top before the full-page capture.
async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });
  await page.waitForTimeout(600);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const results = [];

for (const [width, wlabel] of Object.entries(widths)) {
  const context = await browser.newContext({
    viewport: { width: Number(width), height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  for (const [route, slug] of pages) {
    const url = BASE + route;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      // Hide Astro's dev-only toolbar (it floats at the bottom in `astro dev`
      // and is not present in the production build).
      await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
      await settle(page);
      if (TILES) {
        // Capture the page screen by screen at full viewport resolution.
        const vh = 844;
        const total = await page.evaluate(() => document.body.scrollHeight);
        const n = Math.max(1, Math.ceil(total / vh));
        for (let i = 0; i < n; i++) {
          const y = i * vh;
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          await page.waitForTimeout(250);
          const file = `${OUT}/${width}w-${slug}-t${String(i + 1).padStart(2, '0')}.png`;
          await page.screenshot({ path: file }); // current viewport only
          results.push(`OK   ${file}`);
        }
      } else {
        const file = `${OUT}/${width}w-${slug}.png`;
        await page.screenshot({ path: file, fullPage: true });
        const h = await page.evaluate(() => document.body.scrollHeight);
        results.push(`OK   ${file}  (${width}x${h})`);
      }
    } catch (err) {
      results.push(`FAIL ${OUT}/${width}w-${slug}  ${err.message.split('\n')[0]}`);
    }
  }
  await context.close();
}

await browser.close();
console.log(results.join('\n'));
console.log(`\nDone. ${results.filter((r) => r.startsWith('OK')).length}/${results.length} captured into ${OUT}/`);
