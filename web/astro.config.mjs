// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// Open every guide-body link that leaves the current page in a new tab, so an
// older reader never loses their place mid-guide. Applies to external links,
// jumps to other site pages, and cross-guide links alike — anything whose href
// isn't a same-page "#" anchor. The prev/next pager and sidebar live in .astro
// templates (not MDX), so they're untouched and stay same-tab on purpose.
function rehypeGuideLinksNewTab() {
  const isExternal = (href) => /^[a-z]+:\/\//i.test(href) || href.startsWith('//');

  const apply = (node) => {
    if (!node || typeof node !== 'object') return;

    // Markdown links compile to hast <a> elements; raw <a> tags written in MDX
    // become mdxJsx* nodes. Handle both shapes.
    const isHtmlAnchor = node.type === 'element' && node.tagName === 'a';
    const isJsxAnchor =
      (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') &&
      node.name === 'a';

    if (isHtmlAnchor) {
      const href = node.properties?.href;
      // Skip same-page anchors (#step) — those don't take you off the page.
      if (typeof href === 'string' && !href.startsWith('#')) {
        node.properties.target = '_blank';
        node.properties.rel = isExternal(href)
          ? ['noopener', 'noreferrer']
          : ['noopener'];
      }
    } else if (isJsxAnchor) {
      const hrefAttr = node.attributes?.find(
        (a) => a.type === 'mdxJsxAttribute' && a.name === 'href',
      );
      const href = hrefAttr?.value;
      if (typeof href === 'string' && !href.startsWith('#')) {
        const setAttr = (name, value) => {
          const existing = node.attributes.find(
            (a) => a.type === 'mdxJsxAttribute' && a.name === name,
          );
          if (existing) existing.value = value;
          else node.attributes.push({ type: 'mdxJsxAttribute', name, value });
        };
        setAttr('target', '_blank');
        setAttr('rel', isExternal(href) ? 'noopener noreferrer' : 'noopener');
      }
    }

    if (Array.isArray(node.children)) node.children.forEach(apply);
  };

  return (tree) => apply(tree);
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
    rehypePlugins: [rehypeGuideLinksNewTab],
  },
  integrations: [mdx()],
});
