// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// Open a guide-body link in a new tab whenever it takes the reader away from the
// guide they're following, so an older reader never loses their place. The three
// guide series — Set Up, Learn to Trade (trading/), Master (master/) — are each
// one continuous walkthrough, so a link WITHIN the same series stays same-tab
// (it's the same guide, e.g. Set Up Step 6 → Step 4B). A link to a DIFFERENT
// series, to an off-track site page (plans/pricing), or to an external site
// opens a new tab. Same-page "#" anchors stay put. The prev/next pager and the
// sidebar live in .astro templates (not MDX), so they're untouched (same-tab).
function rehypeGuideLinksNewTab() {
  // Which guide series a /guides/... path belongs to.
  const seriesOf = (path) => {
    if (/^\/guides\/trading(\/|$)/.test(path)) return 'trading';
    if (/^\/guides\/master(\/|$)/.test(path)) return 'master';
    return 'setup'; // /guides and every top-level /guides/<slug>
  };

  // Decide how a link should open, given the series of the page it sits on.
  // Returns null to leave it same-tab, or the rel value for a new-tab link.
  const behaviour = (href, sourceSeries) => {
    if (typeof href !== 'string' || href === '') return null;
    if (href.startsWith('#')) return null; // same-page jump
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith('//')) {
      return 'noopener noreferrer'; // external site
    }
    if (href.startsWith('/')) {
      const path = href.split('#')[0].split('?')[0];
      if (/^\/guides(\/|$)/.test(path)) {
        // Another guide: new tab only if it's a different series.
        return seriesOf(path) === sourceSeries ? null : 'noopener';
      }
      return 'noopener'; // off-track site page (plans/pricing/home)
    }
    return null; // relative or unrecognised — leave alone
  };

  return (tree, file) => {
    // Series of the page being compiled, from its source path.
    const src = String((file && (file.path || (file.history && file.history[0]))) || '')
      .replace(/\\/g, '/');
    const sourceSeries = /\/guides\/trading\//.test(src)
      ? 'trading'
      : /\/guides\/master\//.test(src)
        ? 'master'
        : 'setup';

    const apply = (node) => {
      if (!node || typeof node !== 'object') return;

      // Markdown links compile to hast <a> elements; raw <a> tags written in MDX
      // become mdxJsx* nodes. Handle both shapes.
      const isHtmlAnchor = node.type === 'element' && node.tagName === 'a';
      const isJsxAnchor =
        (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') &&
        node.name === 'a';

      if (isHtmlAnchor) {
        const rel = behaviour(node.properties?.href, sourceSeries);
        if (rel) {
          node.properties.target = '_blank';
          node.properties.rel = rel.split(' ');
        }
      } else if (isJsxAnchor) {
        const hrefAttr = node.attributes?.find(
          (a) => a.type === 'mdxJsxAttribute' && a.name === 'href',
        );
        const rel = behaviour(hrefAttr?.value, sourceSeries);
        if (rel) {
          const setAttr = (name, value) => {
            const existing = node.attributes.find(
              (a) => a.type === 'mdxJsxAttribute' && a.name === name,
            );
            if (existing) existing.value = value;
            else node.attributes.push({ type: 'mdxJsxAttribute', name, value });
          };
          setAttr('target', '_blank');
          setAttr('rel', rel);
        }
      }

      if (Array.isArray(node.children)) node.children.forEach(apply);
    };

    apply(tree);
  };
}

// Add a data-label to every guide-table body cell, copied from its column header,
// so narrow screens can reflow the table into labelled cards instead of cramming
// columns and breaking words mid-string (see `.docs-prose table` in docs.css).
function rehypeTableDataLabels() {
  const textOf = (node) => {
    if (!node) return '';
    if (node.type === 'text') return node.value || '';
    if (Array.isArray(node.children)) return node.children.map(textOf).join('');
    return '';
  };
  const collect = (node, tag, acc) => {
    if (!node || typeof node !== 'object') return acc;
    if (node.type === 'element' && node.tagName === tag) acc.push(node);
    if (Array.isArray(node.children)) node.children.forEach((c) => collect(c, tag, acc));
    return acc;
  };
  const labelTable = (table) => {
    const thead = collect(table, 'thead', [])[0];
    const tbody = collect(table, 'tbody', [])[0];
    if (!thead || !tbody) return;
    const headers = collect(thead, 'th', []).map((th) => textOf(th).trim());
    const rows = (tbody.children || []).filter((c) => c.type === 'element' && c.tagName === 'tr');
    for (const row of rows) {
      const cells = (row.children || []).filter((c) => c.type === 'element' && c.tagName === 'td');
      cells.forEach((td, i) => {
        if (!headers[i]) return;
        td.properties = td.properties || {};
        if (td.properties.dataLabel == null) td.properties.dataLabel = headers[i];
      });
    }
  };
  return (tree) => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'element' && node.tagName === 'table') labelTable(node);
      else if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
  };
}

// Static marketing site. When we add the Pepperstone-discount checkout endpoint
// (phase 2), install @astrojs/vercel and switch output to 'server' for that route.
// MDX powers the docs-style guide pages (sub-step components + image slots).
export default defineConfig({
  site: 'https://rho-market-navigator.vercel.app',
  // The old step-5 "Instrument information" and step-8 "Your backend" pages were
  // folded into the trading-terminal walkthroughs; keep old links/bookmarks alive.
  redirects: {
    '/guides/trading/instrument-information': '/guides/trading/your-trading-terminal',
    '/guides/trading/your-backend': '/guides/trading/your-trading-terminal',
  },
  // @astrojs/mdx inherits markdown.rehypePlugins by default, so this runs on the
  // guide .mdx content. There are no plain .md files, so guides are the only target.
  markdown: {
    rehypePlugins: [rehypeGuideLinksNewTab, rehypeTableDataLabels],
  },
  integrations: [mdx()],
});
