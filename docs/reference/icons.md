---
icon: lucide/sparkles
---

# Icons (Lucide)

Danbyte uses [Lucide](https://lucide.dev) for every UI icon. The full
`lucide-static` SVG set is vendored at `api/lucide/` and exposed to templates
through a single Django tag.

## Usage

```django
{% load api_extras %}

{# default size: h-4 w-4 #}
{% lucide "search" %}

{# pass any class string — fully overrides the default #}
{% lucide "shield-check" "h-3.5 w-3.5 text-zinc-400" %}

{# small dense icon next to text #}
<span class="inline-flex items-center gap-1.5">
  {% lucide "users" "h-3.5 w-3.5" %}
  Tenants
</span>
```

The tag inlines the SVG (no extra HTTP request), strips the upstream
`<!-- @license … -->` comment so the license shows only in the vendored source,
and substitutes the caller's `class=""` so all Tailwind sizing/colour utilities
just work.

If `{% lucide "missing-name" %}` is rendered, the tag returns an empty string
silently — check the spelling against `ls api/lucide/`.

## Rules

- **Never hand-write `<svg>` in a template.** If you can't find the icon you
  need, browse [lucide.dev/icons](https://lucide.dev/icons) — the set has
  1,964 icons.
- Default size is `h-4 w-4`. Use `h-3.5 w-3.5` for dense table/sidebar UI.
- Stroke is `currentColor` — colour with Tailwind utilities (`text-zinc-400`,
  `text-emerald-500`, …) on the parent or directly via the class arg.
- Don't introduce a second icon set. Pick a Lucide icon that's "close enough"
  rather than adding a separate library.

## License

Lucide is ISC-licensed; a subset of icons is MIT-licensed (derived from
[Feather](https://feathericons.com/)). The full license text — including the
list of Feather-derived icons — lives at
[`api/lucide/LICENSE`](https://github.com/) (vendored alongside the SVGs).

When redistributing Danbyte, ship that file unchanged. The Django template tag
also strips the `<!-- @license … -->` comment from each rendered SVG to keep
the HTML compact; the canonical attribution lives in the LICENSE file.
