// @ts-check
import { defineConfig } from 'astro/config';

// Static marketing site. When we add the Pepperstone-discount checkout endpoint
// (phase 2), install @astrojs/vercel and switch output to 'server' for that route.
export default defineConfig({
  site: 'https://rho-market-navigator.vercel.app',
});
