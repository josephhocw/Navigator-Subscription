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
  }),
});

// Learn articles (mastery content), authored as Markdown in src/content/learn/.
// Built self-contained so the section can move behind a login later.
const learn = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/learn' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    // controls ordering within a category (lower = earlier)
    order: z.number().default(99),
    // groups articles on the /learn hub
    category: z.enum(['understand', 'strategies', 'lessons', 'signals']).default('understand'),
  }),
});

export const collections = { guides, learn };
