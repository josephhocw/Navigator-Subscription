import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Step-by-step guides, authored as Markdown in src/content/guides/.
// Add a new .md file with frontmatter and it appears on /guides automatically.
const guides = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    // controls ordering on the /guides hub (lower = earlier)
    order: z.number().default(99),
    // short label shown above the card title, e.g. "Step 1"
    step: z.string().optional(),
  }),
});

export const collections = { guides };
