// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// Static marketing site. When we add the Pepperstone-discount checkout endpoint
// (phase 2), install @astrojs/vercel and switch output to 'server' for that route.
// MDX powers the docs-style guide pages (sub-step components + image slots).
export default defineConfig({
  site: 'https://rho-market-navigator.vercel.app',
  integrations: [mdx()],
});
