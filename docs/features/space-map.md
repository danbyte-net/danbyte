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

- **Green** — free. Nothing is registered in that block.
- **Rose** — used. A child prefix already overlaps that block.
- **Amber** — see [Stray IPs](#stray-ips-amber-cells) below.

Each row is one subnet size, labelled with a free-count (for example
`5/8 free · /19 subnets`), so you can read availability top to bottom.

```text
2/2     free  /25 subnets    [ 10.20.30.0/25 ] [ 10.20.30.128/25 ]
4/4     free  /26 subnets    [ /26 ][ /26 ][ /26 ][ /26 ]
8/8     free  /27 subnets    8 cells
…
```

Hover a rose chip and a tooltip tells you which child prefix is using it.

## Using it to plan

The space map is built to answer carve-out questions fast:

| You want to know… | Do this |
|---|---|
| "How many `/27`s fit here?" | Read the count on the `/27` row. |
| "Where's a free `/28`?" | Look for any green chip on the `/28` row. |
| "Why isn't this `/27` free?" | Hover the rose chip — the tooltip names the child using it. |

**Click any green chip** to start creating a prefix there. The new-prefix form
opens with that block pre-filled and the site and VRF inherited from the parent,
so you only confirm and save.

## Stray IPs (amber cells)

Sometimes a block has no child prefix but *does* already contain individual IP
addresses — IPs recorded directly, with no prefix wrapping them. The space map
paints those cells **amber** and shows a small badge with the IP count, so loose
addresses don't hide behind a green "looks free" chip.

Click an amber cell to create a prefix over those IPs. The form shows an amber
banner warning that the existing IPs will be **adopted** — that is, re-parented
under the new prefix when you save, so the new prefix correctly owns them.

!!! note "Why this matters"
    Without it, you could create a prefix on top of existing addresses and the
    addresses would still be parented elsewhere — a silent mismatch. Adopting
    them keeps everything consistent.

## IPv6

The map works for **IPv6** too. Because a v6 block has astronomically many
subnets, the map shows a couple of nibble-aligned levels (a `/64` shows its
`/68`s and `/72`s) rather than thousands of cells. To go deeper, click a free
cell and choose **Zoom into …** — the map re-roots at that block and a
breadcrumb lets you climb back out. It's the natural way to navigate a sparse
v6 plan one level at a time.

## How deep it draws

By default the map goes to the host boundary. If that's more than you want to
scan, set a shallower cap under **Preferences → Display → Space map depth**
(separately for IPv4 and IPv6) — e.g. stop IPv4 at `/29`. You can always click a
free cell to **zoom in** past the cap. The preference only ever makes the map
*shallower*, never deeper than the safety limit below.

## Limits

- **Up to eight bits deep.** A very large block (say a `/8`) won't try to draw
  millions of `/24`s — it shows the next handful of sizes (IPv6 steps a nibble
  at a time, capped at 256 cells per row, then you zoom in).
- **Down to the host boundary.** IPv4 stops at `/31`; IPv6 at `/127`. A single
  host (`/32` or `/128`) isn't shown — that's what the
  [IPs tab](../dcim/ip-assignment.md) is for.
- Sizes with **no free space** are hidden — there's no point showing "0 free".
