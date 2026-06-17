import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Step-by-step guides, authored as Markdown/MDX in src/content/guides/.
// Add a new .md(x) file with frontmatter and it appears on /guides automatically.
// MDX files can use the guide components (GuideShot, WhatYouNeed, GuideCallout)
// for the docs-style sub-step layout; ## headings become the sidebar anchors.
const guides = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    // controls ordering on the /guides hub (lower = earlier)
    order: z.number().default(99),
    // short label shown above the card title, e.g. "Step 1"
    step: z.string().optional(),
    // hide the on-page subtitle (docs-lede) under the H1 for this guide.
    // description is still used for the meta tag + the /guides hub card.
    hideLede: z.boolean().default(false),
    // which track this guide belongs to: the "Set Up" path (default) or the
    // "Master the Navigator" path. Scopes the sidebar, numbering and pager.
    track: z.enum(['setup', 'master']).default('setup'),
  }),
});

export const collections = { guides };
