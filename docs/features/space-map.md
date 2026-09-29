---
icon: lucide/grid-3x3
---

# Space map

The **Map** tab on a prefix's detail page lays out the address space *inside*
that prefix as a grid of colored chips, so you can see at a glance what's free,
what's used, and where you can carve out your next subnet.

## What it shows

For each subnet size that fits inside the prefix, the map draws one chip per
aligned subnet at that size:

- **Green** - free. No child prefix touches that block.
- **Green with rose bars, rose outline** - partly used. No child prefix covers
  the whole block, but smaller child prefixes sit inside it. Each rose bar marks
  where one sits and how much of the block it takes, so a `/26` holding one
  `/28` shows a bar across its first quarter. The block can't be allocated
  whole, but it still has free space one level down.
- **Rose** - used. The block is an existing child prefix, or sits inside one.
- **Green with a small number** - free, but already holding stray IPs. See
  [Stray IPs](#stray-ips) below.
- **Amber strip along the bottom** - an IP range sits there. See
  [IP ranges](#ip-ranges) below.

A rose bar is the same fill as a used block, so a bar reads exactly as used as
a rose chip. The map never paints free space as taken: children at most a pixel
apart are drawn as one stretch, fainter when there are gaps in it, and when a
block holds many small children scattered across it (more than 16 separate
runs), each sixteenth of the block that holds any gets one thin bar, as wide as
what it holds and placed where it sits. A `/9` with a few dozen `/24`s spread
through it shows a row of slivers over a green block, not a half-rose one.

Each row is one subnet size, labelled with a free-count (for example
`5/8 free /19 subnets · 2 partly used · 1 holds an IP range`), so you can read
availability top to bottom.

```text
2/2     free  /25 subnets    [ 10.20.30.0/25 ] [ 10.20.30.128/25 ]
4/4     free  /26 subnets    [ /26 ][ /26 ][ /26 ][ /26 ]
8/8     free  /27 subnets    8 cells
…
```

Hover any chip for what it is: `Free`, `Free · 2 IPs inside`,
`Free · range 10.196.196.10–50`, `25% used · 10.196.238.128/28` (the child
prefixes inside a partly used block), `Existing prefix`, or
`In 10.196.200.0/24` (the prefix a used block sits in).

## Clicking a chip

A chip with one thing to do does it on click; a chip with several opens a
menu.

| Chip | Click |
|---|---|
| Free | Menu: **Zoom into …**, **New child prefix here**, **Register an IP here**. |
| Partly used | **Zooms in** - the map re-roots at that block, showing the child that is taken and the free blocks around it. |
| Used, exactly a prefix | Menu: **Open …** (the prefix's detail page) and **Zoom into …** (its own space). |
| Used, inside a larger prefix | Menu: **Open …** (that larger prefix) and **Zoom into …**. |

A used block always offers **Zoom into** as well as **Open**, even when it is a
single prefix: zooming maps that prefix's own space, so you can carve it up
without leaving the map you started on. Blocks too small to split further
(IPv4 `/31`, IPv6 `/128`) only offer **Open**.

**New child prefix here** opens the new-prefix form with that block pre-filled
and the site and VRF inherited from the smallest prefix containing it, so you
only confirm and save. Saving (or cancelling) brings you back to the map, zoomed
where you were, with the new prefix drawn - so the next block is one click away.
**Register an IP here** does the same.

The two create actions only show when you may add prefixes or IPs. Without
either, a free block has just **Zoom into …**, so a click zooms straight in.

## Zooming

Zooming re-roots the map at a block. A breadcrumb above the grid shows the path
from the prefix down to the block on screen; click any step to go back to it,
or the zoom-out button to go up one level.

The zoom path is part of the page address
(`?tab=map&zoom=10.196.224.0/19,10.196.238.128/26`), and every zoom is a step
in the browser history. The browser's Back button zooms out again; Back from a
prefix you opened off the map, or from the create form, lands on the same
zoomed view; and a reload or a shared link opens it directly.

When the block on screen is, or sits inside, an existing child prefix, the
breadcrumb links to it (`in 10.196.200.0/24`). Free blocks there belong to that
prefix: **Register an IP here** parents the new IP under it, not under the
prefix the map started from.

Zooming is also how you get past the eight-bit limit below. A `/18` draws its
`/19`-`/26` rows; zoom into a `/26` and the map carries on to `/31`.

Everything on the map works from the keyboard: Tab to a chip, Enter to click it
(or open its menu), arrow keys inside the menu. After a zoom, focus stays in the
map.

## Stray IPs

Sometimes a free block has no child prefix but *does* already contain
individual IP addresses - IPs that are not inside any child prefix drawn on the
map. That includes IPs parented straight to the prefix you are viewing: zoomed
into `10.196.238.128/28`, its own `.129` and `.130` count as stray, since no
smaller prefix holds them. The space map marks those chips with a small count of the
IPs inside, so loose addresses don't hide behind a plain "looks free" chip.

Create a prefix over one of those chips and the form warns that the existing
IPs will be **adopted** - re-parented under the new prefix when you save, so
the new prefix correctly owns them.

!!! note "Why this matters"
    Without it, you could create a prefix on top of existing addresses and the
    addresses would still be parented elsewhere - a silent mismatch. Adopting
    them keeps everything consistent.

## IP ranges

An [IP range](ipam-objects.md#ip-ranges) (a DHCP pool, a reservation) is not
a prefix, so it doesn't make a block used: carving a subnet around a pool is
normal. But the map shows where ranges sit, so you don't carve over one by
accident. A free or partly used chip a range reaches gets an amber strip along
its bottom edge, placed where the range is, and its tooltip names it
(`Free · range 10.196.196.10–50`, or `3 ranges`). The row label counts those
chips.

A range that sits wholly inside a child prefix belongs to that prefix, and is
not marked. Only ranges in the prefix's VRF count.

## IPv6

The map works for **IPv6** too, the same way. Because a v6 block has
astronomically many subnets, the map shows a couple of nibble-aligned levels (a
`/64` shows its `/68`s and `/72`s) rather than thousands of cells. Partly used
blocks zoom in on click like IPv4 ones, which is the natural way to navigate a
sparse v6 plan one level at a time. A bar for a tiny child in a huge block
(a `/128` in a `/56`) still shows as a thin sliver.

## How deep it draws

Each view draws at most eight bits below the block on screen (256 chips per
row), stopping at `/31` for IPv4 and `/128` for IPv6; zooming carries on from
there, down to `/31` or `/128`.

If that's more than you want to scan, set a shallower cap under
**Preferences → Space map (IPv4 / IPv6)** - e.g. stop IPv4 at `/24`. The
preference only ever makes a view *shallower*, never deeper than the eight-bit
limit. It trims the views above it: with `/24`, a `/18` shows `/19`-`/24`, and
a zoom into a `/20` shows `/21`-`/24`. Once you zoom into a block at or below
the cap (a `/24` here), there is nothing left for the cap to trim, so that view
draws its full eight bits (`/25`-`/31`) rather than one row per click. IPv6
zooms keep their nibble steps the same way.

## Limits

- **Up to eight bits deep per view.** A very large block (say a `/8`) won't try
  to draw millions of `/24`s - it shows the next handful of sizes (IPv6 steps a
  nibble at a time, capped at 256 cells per row). Zoom in for the rest.
- **Down to the host boundary.** IPv4 stops at `/31`; IPv6 at `/128`. A single
  IPv4 host (`/32`) isn't shown - that's what the
  [IPs tab](../dcim/ip-assignment.md) is for.
- Only child prefixes you can view count. A prefix hidden from you by site
  scope leaves its block looking free.
- IP ranges and IPs don't make a block used; they are marked on free and partly
  used chips (the amber strip, the stray-IP count).
