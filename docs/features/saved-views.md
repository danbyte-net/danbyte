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

!!! note "Views and column layouts are separate"
    A view remembers *which rows* you want. [Table columns](table-preferences.md)
    remember *which columns* you want, per table. The two combine.
