---
icon: lucide/palette
---

# Design tokens (shadcn / Tailwind 4)

How the frontend's colours and theming work: a shadcn-style **CSS-variable token
system** on **Tailwind 4**, in the React/TanStack SPA. This page is the record of
where the tokens live, how to use them, and how to swap the palette.

!!! note "This is the React SPA"
    The active UI is the React 19 + TanStack + Tailwind 4 + shadcn/Radix app in
    `frontend/` (built with Vite). The earlier htmx/Django-template UI — and its
    `tailwind.config.js` / `design/tokens.css` — are gone; ignore any older notes
    that mention them.

## Where the tokens live

| File | Role |
|---|---|
| `frontend/src/styles.css` | The single source of truth. `@import "tailwindcss"` (Tailwind 4 — configured in CSS, **no `tailwind.config.js`**). A `@theme inline { … }` block maps semantic tokens to Tailwind colour utilities (`--color-primary: var(--primary)` → `bg-primary`). `:root { … }` and the dark variant hold the actual `oklch()` values — paste a tweakcn/shadcn preset here verbatim. |
| `frontend/components.json` | The shadcn manifest (`style: radix-vega`, `baseColor: zinc`, `css: src/styles.css`, Lucide icons). Lets `npx shadcn add <component>` drop new primitives into `components/ui/` with the right paths. |

Dark mode is a `.dark` class on `<html>` (via `@custom-variant dark (&:is(.dark *))`),
toggled by the theme provider; a small inline script in `routes/__root.tsx` sets
it **before first paint** so there's no flash. There is no `tailwind.config.js`
and no separate PostCSS colour config — it's all in `styles.css`.

## Using tokens

Style with the **semantic** utilities the `@theme` block generates — never
hard-coded colours:

- Surfaces: `bg-background`, `bg-card`, `bg-popover`, `bg-muted`, `bg-sidebar`
- Text: `text-foreground`, `text-muted-foreground`, `text-primary`
- Lines/controls: `border-border`, `ring-ring`, `bg-input`
- Intent: `bg-primary` / `text-primary-foreground`, `bg-destructive`, `bg-accent`

Opacity modifiers work against the raw `oklch()` values (`bg-primary/90`,
`border-border/50`) because Tailwind 4 applies them via `color-mix()`
automatically. The neutral palette is **zinc**; reach for a semantic token, not
a `zinc-500`, so a preset swap re-themes everything at once.

## Status colours stay separate

Status, role, and monitoring-check colours are **data**, not part of the theme
palette — they come from each object's own colour (a `Status`/`Role` row's
`color`, or a fixed check-status palette). Render them with `StatusBadge`,
`ColorBadge`, `RoleChip`, or `CheckStatusBadge`; never derive a status colour
from the token palette or hard-code one by name. See
[Visual language](../design/visual-language.md) for the full component rules.

## Swapping the palette

1. Pick/generate a preset (e.g. [tweakcn](https://tweakcn.com/) or the shadcn
   theme editor) and copy its `:root { … }` and dark-mode `oklch()` blocks.
2. Paste them over the corresponding blocks in `frontend/src/styles.css`.
3. `npm run build` (or the dev server) — every semantic utility repaints; no
   component changes needed.

Keep the token **names** identical (`--primary`, `--muted`, `--sidebar`,
`--chart-1..5`, …); only the values change.

## Why `oklch()`

The tokens are authored in `oklch(L C H)` (perceptual lightness/chroma/hue), the
shadcn default. It gives even lightness steps and predictable
`color-mix()`/opacity behaviour across the palette, and modern browsers support
it natively — so the brand blue, its `/90` hover, and the chart ramp all stay
perceptually consistent. Swapping to another preset's `oklch()` values keeps that
property for free.
