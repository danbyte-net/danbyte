---
icon: lucide/palette
---

# Visual language

The visual standard for Danbyte is defined in `/CLAUDE.md` at the project root.
The running React SPA in `frontend/` is its source of truth - read the shared
primitives before adding UI.

## In one breath

Restrained, real, neutral. Borders define edges, not shadows. Color exists
only to convey state. The interface is built for technical operators who scan
a lot of data fast - typography and spacing serve that, not decoration.

## Tokens

- **Neutrals**: Tailwind `zinc`. Not `gray`, not `slate`.
- **Status colors** (only when conveying state):
    - Success - `emerald`
    - Warning - `amber`
    - Danger - `red`
    - Neutral - `zinc`
- **Primary / accent**: `--primary` is Danbyte **blue** (`styles.css`), and the
  chart ramp is built from it. Earlier drafts of this doc claimed a neutral
  primary with no brand accent; the shipped token has been blue for a long time
  and the whole product is built and screenshotted against it, so the doc was the
  stale side and has been corrected here rather than the token. Blue is for
  *primary action and selection only* - it is not decoration, and it never
  carries meaning that belongs to a status colour.
- **One selection colour.** Anything meaning "this is the selected thing" uses
  `--primary`. Canvas surfaces (3D, floor plan, site map, topology) can't read
  CSS variables today and hard-code `#0ea5e9` in ~19 places, which is a
  *different* blue - so selection currently reads as two colours depending on
  which surface you're on. Until a `readCssVar()` bridge exists, keep new canvas
  code on the shared constant rather than adding another literal.
- **Links**: never blue. Use the `.link` class (`styles.css`) - it inherits the
  surrounding text colour and reveals an underline only on **hover** and
  keyboard **focus** (with a focus ring). This keeps link-dense pages from
  turning into a wall of blue while still marking clickability. `--primary` is
  reserved for primary action / selection, never for a link. A trailing
  chain-glyph affordance is available as the opt-in `.link-icon` variant for the
  rare prominent standalone link; it is off by default to avoid per-row clutter
  and hover reflow in tables. The shared cell factories (`components/cells/*`)
  and TanStack `Link`s alike all use `.link`.
- **Mono font**: for every IP, CIDR, MAC, serial, ID, UUID, custom-field key.
- **Tabular nums**: on every counter, percentage, timestamp.
- **Radii**: `rounded-md` and `rounded-lg` only. `rounded-full` for status dots and avatars.
- **Badges are squarish, never pills.** Every count/label chip uses the
  `Badge` primitive (`rounded-[5px]`) - including chips floating over a
  canvas (map, floor plan, topology). Do not hand-roll `rounded-full` pill
  buttons for labels or counts; `rounded-full` stays reserved for status dots
  and avatars. Severity chips use the semantic variants (`destructive`,
  `warning`, `success`) as **separate badges per severity**, not one combined
  pill. Chips overlaying a tinted/tiled canvas sit on a solid
  `bg-background/95 rounded-md border` backdrop so the tint reads.
- **Shadows**: don't. Borders define edges. Exception: dropdowns/popovers get `shadow-sm`.

See `/CLAUDE.md` for the canonical class snippets per component (button,
badge, tag, table, dropdown, etc).

## Where to look

- `frontend/src/styles.css` - the active design tokens and global styling
- `frontend/src/components/ui/` - the shadcn primitives (button, badge, input,
  checkbox, select, command, popover, dialog, …)
- `frontend/src/components/forms/` - the form-field layer built on those
  primitives, re-exported from one barrel (`@/components/forms`)
- `frontend/src/components/` - shared and domain components (`DataTable`,
  `ListPageShell`, `DetailShell`, `KvCard`, `StatusBadge`, `ObjectPicker`, …)
- `docs/architecture/shadcn-tokens.md` - the token/variable reference

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

Radix controls report changes differently from DOM ones - `Checkbox` uses
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
| `Input`, `Textarea`, `SelectTrigger`, `Combobox` | `w-full min-w-0` - fill the slot, and stay shrinkable |
| compact toolbar control | an explicit `w-*` **plus `shrink-0`** at the call site |

Never let a control size itself to its *content*. `SelectTrigger` shipped with
upstream shadcn's `w-fit`, so it was narrow when empty and grew when a value was
picked - a labelled field in a grid row changed width and shoved its neighbours.

Long values **ellipsise**, they don't clip. Watch for one trap: `truncate` and
`line-clamp-*` both set `display`, so they lose to a sibling `flex` on the same
element. If a value span needs `flex` (icon + text), put the truncation on the
inner text node instead.

## Dialog width: use `size`, never a class

`DialogContent` and `AlertDialogContent` take a `size` prop
(`sm | md | lg | xl | 2xl | 3xl`, default `md` = 28rem) which is keyed off
`data-size`.

**Do not pass a width class.** `cn()` is tailwind-merge, which only dedupes
classes carrying the *same* modifier - so an unprefixed `max-w-lg` does **not**
cancel the primitive's `sm:max-w-*`. Both land, specificity ties, and Tailwind
emits the variant later, so the default wins on every desktop. Six dialogs
shipped believing they were wide and weren't. `data-size` can't be clobbered
that way.

Pick by content, not by taste: `md` for 2–4 fields, `lg` for 5–7, `xl` for 8+ or
any 2-column grid, `2xl`/`3xl` for tables, trees and traces.

## List-page chrome

Every list page is `ListPageShell` + `DataTable` - no exceptions, so header
height, search placement, action order, and the loading/error/empty treatment
can't drift page to page (source of truth:
`frontend/src/components/list-page-shell.tsx`, reference implementation
`routes/manufacturers.index.tsx`):

- The shell owns the h-14 header (title · count chip · search · actions) and the
  scrolling body. Header order is fixed: **search first, then the action
  cluster** - `TableActions` (Import / Export) and then `Add X`.
- `Add X` is the copy for a create button, with **no icon**. Not "New X".
- Filters live in the rail (`FilterRail` + `FacetGroup`, usually via
  `useTableFilters`), not in a second toolbar row under the header. A filter that
  is genuinely either/or (no "any" state) is a `SegmentedTabs` switch in the
  action cluster instead; a single-select filter over a long fixed list can be a
  `Select` under a rail heading.
- A facet with no options renders nothing, and a **derived** enum facet (a
  yes/no or state split computed from the row rather than read off a catalog
  object) sets `hideWhenSingle` so it also disappears when every row lands in
  the same bucket - ticking its one option would select the whole table. Rail
  length is the budget: a rail you have to scroll to reach Manufacturer is worse
  than a short one.
- Empty is either the `DataTable` "No results." row (a filter matched nothing)
  or an `EmptyState` carrying first-run guidance (nothing exists yet) - never a
  bare paragraph. Loading and errors are the shell's, via its `query` prop.
- A **tabbed** list (Prefixes, Drift, Alerts, Compliance, Jobs) puts one h-10
  `SegmentedTabs` strip *above* the shell and renders a shell per tab, so each
  tab supplies its own count, search, rail, and actions.
- Tables are paged by `DataTable` alone. When the API pages server-side, hand it
  `serverPagination={{ page, pageCount, totalRows, onPageChange }}` so that one
  pager drives the server - don't add a second Prev/Next row.
- A list that is a view *of* another list (e.g. `/racks/elevations`) gets the
  shell's `backTo` / `backLabel` breadcrumb rather than its own nav.

Row actions always go through `RowActions` / `actionsColumn()`, and every
list-page table names a `tableId` so it gets the persistent column picker.

## Column factories

**One entity, one column factory** (`frontend/src/components/columns/`), reused
by its list page *and* every embedded table. A second `ColumnDef[]` for the same
entity is how a row starts reading differently depending on which page you
opened it from - a device that shows its compliance marker on `/devices` and
hides it on the site page, a site link that is blue in one table and neutral in
the next.

| Entity | Factory |
|---|---|
| Prefix | `buildPrefixColumns()` |
| IP address | `buildIpColumns()` |
| Device | `buildDeviceColumns()` |
| Interface | `buildInterfaceColumns()` (+ `DEVICE_INTERFACE_COLUMNS` preset) |
| VLAN | `buildVlanColumns()` |
| Rack | `buildRackColumns()` |
| Cluster | `buildClusterColumns()` |
| Virtual machine | `buildVmColumns()` |
| Aggregate | `buildAggregateColumns()` |
| Cable | `buildCableColumns()` |
| VRF | `buildVrfColumns()` |
| Site | `buildSiteColumns()` |
| Device type | `buildDeviceTypeColumns()` |
| Device role | `buildDeviceRoleColumns()` |
| Service | `buildServiceColumns()` |

Each takes options - never per-caller branches inside the factory:

- `include` / `omit` pick columns; the factory's canonical order always applies,
  so two pages showing the same columns cannot show them in a different order.
  `buildPrefixColumns` also takes `order` for the one surface that genuinely
  leads with a different column.
- `selection`, `actions`, `humanIds` add the checkbox, `actionsColumn()`, and
  the `#` numid column.
- `violations` adds the compliance marker, `monitoring` the roll-up status
  column, `tagFilter` wires tag chips to a page filter (omit it and the chips
  are static rather than falsely clickable), `cfDefs` adds custom-field columns.
- A handful carry a named presentation knob where an embedded pane genuinely
  renders a column differently from the list - `siteVariant` (linked vs muted
  plain text), `buildClusterColumns`' `typeVariant`, `buildCableColumns`'
  `labelVariant` / `terminationsLinked` / `statusEditable`,
  `buildServiceColumns`' `linked` (the device / VM pane renders the name and IP
  as plain text), and the header labels `vidHeader` / `nameHeader` /
  `heightHeader`. Prefer one of these over a second `ColumnDef[]`; the point is
  that the variant is declared at the call site instead of hidden in a copied
  column.
- `plainHeaders`, `zeroCounts` and `countFacets` keep an older surface reading
  exactly as it did: a read-only or embedded table that never offered sorting on
  a column, one that prints `0` rather than `-` for an empty count, or a tab that
  filters counts by range instead of the list page's in-use / unused split.
- A page's own columns are **spliced around** the factory's output (rack
  position, monitoring bindings, a virtual-chassis Member column, the cables
  list's trace-plus-row-actions pair) - see `routes/locations.$id.tsx`,
  `routes/racks.$id.tsx`, and `routes/cables.index.tsx`.

Object references inside a cell come from `components/cells/`: `siteColumn` /
`SiteCell`, `deviceColumn` / `DeviceCell`, plus `locationColumn`,
`rackColumn`, `platformColumn`, `manufacturerColumn`, `vrfColumn`, `tagsColumn`,
`timeAgoColumn`, `numidColumn`. They render a reference as a link (never plain
text), underlined on hover and **never `text-primary` blue**, and they carry the
facet meta the filter rail reads. Each column helper takes `className` for
tables that run `text-xs`.

## Detail-page tabs

Every object detail page follows one tab convention (source of truth:
`frontend/src/components/segmented-tabs.tsx`, reference implementations
`routes/devices.$id.tsx` and `routes/interfaces.$id.tsx`):

- The breadcrumb header and the summary section carry **only the headline**:
  the object's name/title, status/state badges, tags, description, and at most
  one or two truly identifying stats (e.g. Site + Primary IP on a device).
  Don't crowd the header with a long `<dl>` of attributes.
- All the remaining attributes live in an **Overview** tab - the first tab,
  and the default - rendered as `KvCard` tables (`<KvCard title rows>`) in a
  `grid gap-6 lg:grid-cols-2`, grouped into a few sensibly-titled cards. This
  is the "read it as tables in the page body" layout.
- After Overview come the related-object tabs (with a count where the API
  provides one), then always **Journal** and **Change log** as the last two, in
  that order.

Never render Change log (`ChangeLogPanel`) or Journal (`JournalPanel`) - or a
wall of attribute fields - inline in the header. Attributes go in the Overview
tab's `KvCard`s; history and journal are always their own tabs.

## The detail hero

The summary section itself is `DetailHero`, passed to `DetailShell`'s `hero`
prop (source of truth: `frontend/src/components/detail-shell.tsx`, reference
implementation `routes/aggregates.$id.tsx`). It owns the section wrapper, the
title element and its size, and the stat rail - a page only supplies content:

| slot | renders |
|---|---|
| `title` (+ `mono`) | the page's single `<h1>`, always `text-2xl font-semibold tracking-tight` |
| `badges` | status/state chips, inline with the title and wrapping with it |
| `subtitle` | one secondary line - a parent link, a facility ID, ports, a second row of chips |
| `tags` | `<TagList tags={…} />` |
| `description` | the object's description |
| `children` | anything else in the left column, below the description |
| `stats` + `statCols` | `<DetailStat/>`s in the right-hand rail (1, 2 or 3 columns) |

**Never pass a title size, and never hand-roll the section.** The hero was
copied 42× before this primitive existed and had drifted to four title sizes
(`text-lg`, `text-xl`, `text-2xl`, `text-3xl`), three title elements
(`div`/`span`/`h1`, only four of them a real heading), two incompatible
layouts, a local `DetailStat` fork that rendered prefix utilisation 50% larger
than every other stat in the product, and one page (cables) with no title at
all. If a title is an identifier - IP, CIDR, ASN, interface, circuit ID - pass
`mono`; if it *is* a coloured catalog object, pass the `ColorBadge` as `title`
so the badge still sizes itself and the `<h1>` still lands in the document
outline.

A hero needing an extra full-width band under it (SNMP credentials,
`CustomFieldValues`, a usage note) renders `DetailHero` and the band as
siblings in a fragment. Prefer folding the content into a slot: extra stacked
strips push the tab bar down the page, which is why the prefix page's ancestor
chain is now its hero `subtitle` and its subnet-details disclosure sits at the
top of the Overview tab.
