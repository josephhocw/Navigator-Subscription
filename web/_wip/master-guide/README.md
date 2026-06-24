# Master the Navigator — work in progress (stored)

This folder holds the **full Master the Navigator guide** as it stood before we
swapped `/guides/master` for a temporary "in progress" placeholder. Nothing here
is built or served — it sits outside `src/`, so Astro ignores it. It's a safe
parking spot until the guide is ready to publish.

## What's here

The five stage pages (MDX content), in order:

| Order | File | Title |
|---|---|---|
| 1 | `read-the-chart.mdx` | Read the chart |
| 2 | `core-skills.mdx` | Core skills |
| 3 | `trade-setups.mdx` | Trade setups & tips |
| 4 | `reading-the-signals.mdx` | Reading the Telegram signals |
| 5 | `set-your-alerts.mdx` | Set your alerts (optional) |

`master.astro.original` is the original hub page (the timeline that listed the
five stages). The live `src/pages/guides/master.astro` is currently the
placeholder.

## How to restore (publish the guide)

From `web/`:

1. Move the five `.mdx` files back into the content collection:
   ```powershell
   New-Item -ItemType Directory -Force -Path "src\content\guides\master" | Out-Null
   Move-Item "_wip\master-guide\*.mdx" "src\content\guides\master\"
   ```
2. Restore the original hub:
   ```powershell
   Copy-Item "_wip\master-guide\master.astro.original" "src\pages\guides\master.astro" -Force
   ```
3. Delete this `_wip\master-guide` folder once everything's back.

That's it — the five `/guides/master/...` routes regenerate automatically and the
hub lists them again.
