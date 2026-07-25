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
| Free text with common values | `FormText` with `suggestions` (or `SuggestInput` directly) | `<datalist>`, or a `<select>` that locks out other values |
| Object reference | `ObjectPicker` or an existing domain picker preset | a bespoke fetch + list |

Radix controls report changes differently from DOM ones — `Checkbox` uses
`onCheckedChange(bool)` and `Select` uses `onValueChange(string)`, not
`onChange(event)`. A Radix `SelectItem` also cannot carry `value=""`; give an
"any" row a sentinel value and map it at both ends.

> **Dead classes have bitten this codebase three times.** The archived
> `reference/design/tokens.css` was deleted in `9ba017d` while 450+ call sites
> still referenced its classes:
>
> | class | sites | found |
> |---|---|---|
> | `.ck` (checkboxes → browser defaults) | ~40 | 2026 |
> | `.num` (tabular figures) | 367 | 2026-07 |
> | `text-destructive-foreground` (delete buttons) | 89 | 2026-07 |
>
> All three are fixed, `.num` now lives in `src/styles.css`, and destructive
> confirms use `variant="destructive"`. The lesson stands: **if you find a class
> with no definition behind it, delete the markup and use a primitive.** Grep
> `styles.css` before trusting a bare class name.

## Widths and truncation are the primitive's job

A control must declare *one* width contract, and the shared primitives do:

| primitive | contract |
|---|---|
| `Input`, `Textarea`, `SelectTrigger`, `Combobox` | `w-full min-w-0` — fill the slot, and stay shrinkable |
| compact toolbar control | an explicit `w-*` **plus `shrink-0`** at the call site |

Never let a control size itself to its *content*. `SelectTrigger` shipped with
upstream shadcn's `w-fit`, so it was narrow when empty and grew when a value was
picked — a labelled field in a grid row changed width and shoved its neighbours.

Long values **ellipsise**, they don't clip. Watch for one trap: `truncate` and
`line-clamp-*` both set `display`, so they lose to a sibling `flex` on the same
element. If a value span needs `flex` (icon + text), put the truncation on the
inner text node instead.

## Dialog width: use `size`, never a class

`DialogContent` and `AlertDialogContent` take a `size` prop
(`sm | md | lg | xl | 2xl | 3xl`, default `md` = 28rem) which is keyed off
`data-size`.

**Do not pass a width class.** `cn()` is tailwind-merge, which only dedupes
classes carrying the *same* modifier — so an unprefixed `max-w-lg` does **not**
cancel the primitive's `sm:max-w-*`. Both land, specificity ties, and Tailwind
emits the variant later, so the default wins on every desktop. Six dialogs
shipped believing they were wide and weren't. `data-size` can't be clobbered
that way.

Pick by content, not by taste: `md` for 2–4 fields, `lg` for 5–7, `xl` for 8+ or
any 2-column grid, `2xl`/`3xl` for tables, trees and traces.

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
