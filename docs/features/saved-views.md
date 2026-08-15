---
icon: lucide/list-filter
---

# Saved views

A view is a search and a set of filters, under a name. Instead of rebuilding
"decommissioning switches in Aarhus" every morning, save it once and pick it
from the **Views** menu on that list.

## Saving one

1. Filter the list however you like — the search box, the filter rail, or both.
2. Open **Views** in the list's toolbar and choose **Save current filters**.
3. Name it. Tick **Share** if the whole tenant should have it.

The menu then shows your views and the shared ones, with who owns each. Picking
one applies its search and filters; **Clear** puts the list back to everything.

If you change the filters after applying a view, the button says **edited** —
what you're looking at is no longer what the view describes. **Update** writes
the current filters back to it (your own views only).

## Sharing

Views are **private until you share them**. A shared view is visible to everyone
in the tenant, and only its author can rename, redefine or delete it — so a view
your team relies on can't be changed underneath them.

Sharing a view does not share data. Applying it re-runs *your* list request, so
you see the rows you already had access to: the same shared view can show a
site-scoped engineer fewer devices than it shows an administrator, never more.

## Which lists have them

Devices, IPs, prefixes, VLANs, racks, sites, locations, circuits, cables,
clusters, device types, certificates, tunnels, wireless LANs and power feeds.

A list gets saved views by handing the control its object type and its filter
handle — the filters themselves come from the columns the list renders, so
there's no per-model filter language to learn or maintain.

## Advanced filter expressions

The **Advanced** entry at the top of every filter rail holds one expression per
list, edited two ways over the same definition:

- a **builder** — rows of *field · operator · value*, combined with
  *match all* / *match any*, with fields and value suggestions taken from the
  rows the list has actually loaded;
- a **typed expression** in a small grammar, for conditions the builder can't
  express (mixed and/or with parentheses):

```
status = active and (site.name ~ cph or tags ~ core)
due_date < 2026-09-01 and assignees is not empty
weight > 100 or description is empty
```

The grammar: `field op value`, joined with `and` / `or` (`and` binds tighter;
parentheses override). Fields are dotted paths into the row (`status.name`,
`site.name`, `tags`); a path landing on an object compares its name, and one
landing on a list matches when any element does. Operators: `=` `!=` (or
`is` / `is not`), `~` `!~` (contains), `<` `>` `<=` `>=` (numeric when both
sides are numbers, otherwise text — which orders ISO dates correctly), and
`is [not] empty`. String compares are case-insensitive; quote values with
spaces.

The expression stacks with the facet rail and the search box, counts toward
the header's filter badge, and is captured by saved views — so "core switches
in CPH due this month" can be one shared view.

!!! note "Views and column layouts are separate"
    A view remembers *which rows* you want. [Table columns](table-preferences.md)
    remember *which columns* you want, per table. The two combine.
