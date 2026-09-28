import type { Pt, Rect } from "./types"

// Devices with no cable at all - a big site's spare stock, servers not
// cabled yet - say nothing about the wiring, and a layered layout spreads
// them over far rows. The Diagram lays them out apart instead: a compact
// grid block under the wired map, one group per role (alphabetical, no
// role last), each group's devices by name. Pure.

export const PACK = {
  /** Between two devices in a group. */
  GAP: 24,
  /** Between two groups. */
  GROUP_GAP: 64,
  /** Between the wired map and the block. */
  OFFSET: 120,
  /** The block's shape when there is no wired map to match. */
  ASPECT: 16 / 9,
} as const

/** A device to pack: its group (role name, "" for none), name and box. */
export interface Loose {
  id: string
  group: string
  name: string
  w: number
  h: number
}

const natural = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })

/**
 * Centres for the `loose` devices: a grid block under `above` (the wired
 * map's box), left-aligned with it and at least as wide; without one, a
 * block of about `PACK.ASPECT` round the origin's corner. Each group is a
 * grid of equal cells (its largest box); groups fill shelves left to
 * right, a group wider than a shelf taking one of its own.
 */
export function packLoose(
  loose: readonly Loose[],
  above: Rect | null
): Map<string, Pt> {
  const out = new Map<string, Pt>()
  if (!loose.length) return out
  const groups = new Map<string, Loose[]>()
  for (const l of loose) {
    const g = groups.get(l.group)
    if (g) g.push(l)
    else groups.set(l.group, [l])
  }
  const order = [...groups.keys()].sort((a, b) =>
    !a !== !b ? (a ? -1 : 1) : natural(a, b) || (a < b ? -1 : a > b ? 1 : 0)
  )
  const cells = order.map((key) => {
    const items = groups
      .get(key)!
      .sort(
        (x, y) =>
          natural(x.name, y.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
      )
    return {
      items,
      cw: Math.max(...items.map((i) => i.w)),
      ch: Math.max(...items.map((i) => i.h)),
    }
  })
  const area = cells.reduce(
    (sum, c) => sum + c.items.length * (c.cw + PACK.GAP) * (c.ch + PACK.GAP),
    0
  )
  const width = Math.max(above?.w ?? 0, Math.sqrt(area * PACK.ASPECT))
  const x0 = above?.x ?? 0
  const y0 = above ? above.y + above.h + PACK.OFFSET : 0
  let x = 0
  let y = 0
  let shelf = 0
  for (const { items, cw, ch } of cells) {
    const pitchX = cw + PACK.GAP
    const cols = Math.max(
      1,
      Math.min(items.length, Math.floor((width + PACK.GAP) / pitchX))
    )
    const rows = Math.ceil(items.length / cols)
    const bw = cols * pitchX - PACK.GAP
    const bh = rows * (ch + PACK.GAP) - PACK.GAP
    if (x > 0 && x + bw > width) {
      x = 0
      y += shelf + PACK.GROUP_GAP
      shelf = 0
    }
    items.forEach((it, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      out.set(it.id, {
        x: x0 + x + col * pitchX + cw / 2,
        y: y0 + y + row * (ch + PACK.GAP) + ch / 2,
      })
    })
    x += bw + PACK.GROUP_GAP
    shelf = Math.max(shelf, bh)
  }
  return out
}
