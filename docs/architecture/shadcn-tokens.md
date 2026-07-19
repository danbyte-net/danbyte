---
icon: lucide/palette
---

# Theme tokens (shadcn-style)

**Adopted: 2026-06-15.** Tweakcn preset `b5JOExNUO` (sky-blue brand).

This page is the canonical record of why we adopted shadcn's CSS variable
system + how to use it + how to swap presets later.

## What we did NOT do

We did **not** rewrite to React + shadcn-the-component-library. That was
on the table — the user even asked about
`npx shadcn@latest init --template start`. We considered it and chose not
to. The short version is:

- IPAM users live in tables. Server-rendered tables are *faster* than SPA
  tables (no spinner-purgatory, no client/server state sync bugs).
- Plugin ecosystem story: a Django app drops in; a React plugin system is
  double the surface area.
- Self-hosters install one Python venv, not Node + npm + bundle pipeline.
- We had just finished bulk-edit, filters, settings, picker, space map,
  import re-parent — none of that survives a rewrite without weeks of
  re-implementation.

## What we DID do

Adopted the *theme system* from shadcn — CSS variables + token discipline
— layered onto the existing Django + htmx + Tailwind stack.

### Files

| File | Role |
|---|---|
| `design/tokens.css` | Owns the `:root { … }` and `.dark { … }` blocks. Paste any tweakcn / shadcn preset here verbatim. |
| `tailwind.config.js` | Extends `theme.colors` with `primary`, `secondary`, `muted`, `accent`, `destructive`, `card`, `popover`, `sidebar`, `chart-1..5`. Has a `color-mix()` helper so `bg-primary/90` (opacity modifiers) work against raw `oklch()` literals. |
| `components.json` | shadcn's manifest. Present so that *if* we ever add a React island, `npx shadcn add <component>` knows the project layout. |

### Usage

```html
{# OLD — hard-coded zinc, theme swap is a global find-and-replace #}
<button class="bg-zinc-900 text-white hover:bg-zinc-800
               dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
  Save
</button>

{# NEW — semantic token, theme swap is one variable #}
<button class="bg-primary text-primary-foreground hover:bg-primary/90">
  Save
</button>
```

| Surface | Token |
|---|---|
| Primary action (Save, Add, Create) | `bg-primary text-primary-foreground hover:bg-primary/90` |
| Secondary action | `bg-secondary text-secondary-foreground hover:bg-secondary/80` |
| Destructive armed state | `bg-destructive text-destructive-foreground hover:bg-destructive/90` |
| Card surface | `bg-card text-card-foreground border-border` |
| Popover / dropdown | `bg-popover text-popover-foreground` |
| Sidebar surface | `bg-sidebar text-sidebar-foreground` |
| Active sidebar item | `bg-sidebar-accent text-sidebar-accent-foreground` |
| Chart colour 1–5 | `bg-chart-1` … `bg-chart-5` |
| Muted / subtle text | `text-muted-foreground` |
| Page border | `border-border` |
| Focus ring | `ring-ring` |

### Status colours stay separate

Success / warning / danger / neutral (`emerald` / `amber` / `red` /
`zinc`) are **semantic** colours that always mean the same thing. They
have their own variables (`--success`, `--warning`, `--danger`) and a
tenant theme swap never touches them. The
status-badge component is the canonical render site for these.

## Swapping presets

Pick a preset on <https://tweakcn.com> or <https://ui.shadcn.com/themes>.
Each one exposes a `:root { … }` block of CSS variables.

1. Copy the entire `:root { … }` block (and `.dark { … }`).
2. Paste it into `design/tokens.css`, replacing the existing two blocks.
3. Run `make css`.
4. Done. No template changes, no rebuild of any Django code.

If a preset adds new variables (newer shadcn revisions add tokens like
`--sidebar-foreground` etc.), the existing CSS just drops back to the
inherited token until you wire it into `tailwind.config.js`.

## Why `color-mix()` and not `hsl()`

Older shadcn presets emit HSL components (`240 5.9% 10%`) which Tailwind
3 can extract opacity from via `hsl(var(--primary) / <alpha-value>)`.
The newer tweakcn / shadcn presets emit `oklch()` literals
(`oklch(0.5 0.134 242.749)`). Tailwind 3 can't extract an alpha channel
from an opaque function literal, so `bg-primary/90` silently produces no
hover effect.

The fix in `tailwind.config.js` is a small color-token factory: it
returns plain `var(--primary)` when no opacity modifier is present, and
emits `color-mix(in srgb, var(--primary) 90%, transparent)` when one is.
This works in every browser since 2023 (Chrome 111+, Firefox 113+,
Safari 16.4+) — which is also the minimum baseline for `oklch()` itself,
so we're not introducing a new compat floor.

## What's still pure-Tailwind (and that's fine)

Most of the codebase still uses stock Tailwind classes (`bg-zinc-50`,
`text-zinc-700`, `border-zinc-200`). That's intentional — these are
**design-system** rules baked into CLAUDE.md, not brand-themable. A
re-skin should change the *brand* (primary, sidebar accent), not the
*surface palette* (zinc).

The migration we did was narrow on purpose: the primary action button,
the sidebar active state, the logo badge, utilization bar fills, the
no-script Apply button. That's ~31 sites. Hard-coded zinc surfaces stay
zinc until and unless we genuinely want surface re-themes (we don't).
