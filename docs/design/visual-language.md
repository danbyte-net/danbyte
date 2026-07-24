---
icon: lucide/palette
---

# Visual language

The visual standard for Danbyte is defined in `/CLAUDE.md` at the project root.
The running React SPA in `frontend/` is its source of truth — read the shared
primitives before adding UI.

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

- `frontend/src/styles.css` — the active design tokens and global styling
- `frontend/src/components/ui/` — the shadcn primitives (button, badge, input,
  checkbox, select, command, popover, dialog, …)
- `frontend/src/components/forms/` — the form-field layer built on those
  primitives, re-exported from one barrel (`@/components/forms`)
- `frontend/src/components/` — shared and domain components (`DataTable`,
  `ListPageShell`, `DetailShell`, `KvCard`, `StatusBadge`, `ObjectPicker`, …)
- `docs/architecture/shadcn-tokens.md` — the token/variable reference

## Never hand-roll a control

Every interactive control comes from the primitives above. A native
`<input type="checkbox">`, `<select>`, or a `<div>` styled to look like one is
wrong even when the classes approximate the design: it renders with the
browser's own widget, ignores the theme, and drifts the moment tokens change.

| Need | Use | Not |
|---|---|---|
| Checkbox with a label | `FormCheckbox` from `@/components/forms` | `<label><input type="checkbox">` |
| Bare checkbox (table cell, list row) | `Checkbox` from `@/components/ui/checkbox` | `<input type="checkbox">` |
| Dropdown of fixed options | `FormSelect`, or `Select` for an unlabelled one | `<select>` |
| Long / searchable option list | `FormCombobox` / `Combobox` | `<select>` with many `<option>`s |
| Searchable picker in a popover | `Popover` + `Command` (see `ui/combobox.tsx`) | a hand-built input + `<button>` list |
| Free text with common values | `FormText` with `suggestions` (renders a `<datalist>`) | a hard-coded `<select>` |
| Object reference | `ObjectPicker` or an existing domain picker preset | a bespoke fetch + list |

Radix controls report changes differently from DOM ones — `Checkbox` uses
`onCheckedChange(bool)` and `Select` uses `onValueChange(string)`, not
`onChange(event)`. A Radix `SelectItem` also cannot carry `value=""`; give an
"any" row a sentinel value and map it at both ends.

> Historical note: an old `.ck` checkbox class from the archived htmx/Tailwind
> pipeline was copied into SPA markup long after the stylesheet defining it was
> removed. Those controls silently rendered as browser defaults. If you find a
> class with no definition behind it, delete the markup and use a primitive.

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
