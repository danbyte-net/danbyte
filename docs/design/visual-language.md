---
icon: lucide/palette
---

# Visual language

The visual standard for Danbyte is defined in `/CLAUDE.md` at the project root
and the static mockups in `design/` are its source of truth.

## In one breath

Restrained, real, neutral. Borders define edges, not shadows. Color exists
only to convey state. The interface is built for technical operators who scan
a lot of data fast — typography and spacing serve that, not decoration.

## Tokens

- **Neutrals**: Tailwind `zinc`. Not `gray`, not `slate`.
- **Status colors** (only when conveying state):
    - Success — `emerald`
    - Warning — `amber`
    - Danger — `red`
    - Neutral — `zinc`
- **Primary button**: high-contrast neutral (black in light mode, white in dark). **No** brand accent color.
- **Links**: dotted underline, not blue.
- **Mono font**: for every IP, CIDR, MAC, serial, ID, UUID, custom-field key.
- **Tabular nums**: on every counter, percentage, timestamp.
- **Radii**: `rounded-md` and `rounded-lg` only. `rounded-full` for status dots and avatars.
- **Shadows**: don't. Borders define edges. Exception: dropdowns/popovers get `shadow-sm`.

See `/CLAUDE.md` for the canonical class snippets per component (button,
badge, tag, table, dropdown, etc).

## Where to look

- `design/index.html` — token gallery + links to the four mockup pages
- `design/prefixes.html` — canonical list-page mockup
- `design/devices.html` — older list mockup (pending redesign)
- `design/ip-detail.html` — detail page mockup
- `design/device-detail.html` — detail page with tabs + rack visualisation
- `design/tokens.css` — `.ck` checkbox, `.num`, table stripes, `<details>` resets
- `design/theme.js` — persistent dark/light toggle (`localStorage['danbyte-theme']`)

## Component patterns extracted so far

| Pattern | In template |
|---|---|
| Sidebar shell | `api/templates/api/_shell.html` |
| Prefix row | `api/templates/api/_prefix_row.html` |
| Custom checkbox `.ck` | `design/tokens.css` |
| Status dot + word | inline classes |
| Tag chip (colored / colorless) | inline classes |
| Stripes toggle | `data-stripes="on"` + JS + `tokens.css` |
| Columns dropdown | `<details>` + `data-col-toggle` + `localStorage['danbyte-cols-prefixes']` |

When React extraction lands, these become small classless-by-default
components — `Button`, `Badge`, `Tag`, `Card`, `DataTable`, `DescriptionList`,
`FilterChip`, `Tabs`, `Sidebar`, `Topbar`, etc.

## Detail-page tabs

Every object detail page follows one tab convention (source of truth:
`frontend/src/components/segmented-tabs.tsx`, reference implementations
`routes/devices.$id.tsx` and `routes/interfaces.$id.tsx`):

- The breadcrumb header and the summary section carry **only the headline**:
  the object's name/title, status/state badges, tags, description, and at most
  one or two truly identifying stats (e.g. Site + Primary IP on a device).
  Don't crowd the header with a long `<dl>` of attributes.
- All the remaining attributes live in an **Overview** tab — the first tab,
  and the default — rendered as `KvCard` tables (`<KvCard title rows>`) in a
  `grid gap-6 lg:grid-cols-2`, grouped into a few sensibly-titled cards. This
  is the "read it as tables in the page body" layout.
- After Overview come the related-object tabs (with a count where the API
  provides one), then always **Journal** and **History** as the last two, in
  that order.

Never render History (`ChangeLogPanel`) or Journal (`JournalPanel`) — or a
wall of attribute fields — inline in the header. Attributes go in the Overview
tab's `KvCard`s; history and journal are always their own tabs.
