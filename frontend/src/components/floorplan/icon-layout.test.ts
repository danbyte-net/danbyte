import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import type { Pt } from "./cable-route"
import {
  CLUSTER_CAP_SIDES,
  CLUSTER_ICON,
  CLUSTER_SIDE,
  clusterExtent,
  clusterFace,
  clusterFitView,
  clusterName,
  drawnCentre,
  layoutIcons,
  pullOut,
  worstCheck,
  zoomBucket,
} from "./icon-layout"
import type { IconItem, IconLayout } from "./icon-layout"

const S = 28

const rack = (
  id: string,
  name: string,
  x: number,
  over: Partial<FloorPlanTile> = {}
): FloorPlanTile =>
  ({
    id,
    x,
    y: 10,
    width: 1,
    height: 1,
    orientation: 0,
    label: name,
    linked: { kind: "rack", id: `r-${id}`, name, role: null },
    tile_type: null,
    role_type: null,
    ...over,
  }) as unknown as FloorPlanTile

/** Every drawn box (units) of a layout, single or cluster. */
function drawn(items: readonly IconItem[], l: IconLayout, scale: number) {
  const out: { id: string; c: Pt; side: number }[] = []
  for (const item of items) {
    if (l.clusterOf.has(item.id)) continue
    const c = drawnCentre(l, item.id, item.c, scale)
    out.push({ id: item.id, c: [c[0] * scale, c[1] * scale], side: S })
  }
  for (const c of l.clusters) {
    const p = drawnCentre(l, c.id, c.anchor, scale)
    out.push({
      id: c.id,
      c: [p[0] * scale, p[1] * scale],
      side: S * CLUSTER_SIDE,
    })
  }
  return out
}

function overlaps(boxes: ReturnType<typeof drawn>) {
  let n = 0
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const d = (a.side + b.side) / 2
      if (
        Math.abs(a.c[0] - b.c[0]) < d - 0.01 &&
        Math.abs(a.c[1] - b.c[1]) < d - 0.01
      )
        n++
    }
  return n
}

const items = (pts: [number, number][]): IconItem[] =>
  pts.map((c, i) => ({ id: `t${i}`, c }))

describe("layoutIcons: spread", () => {
  it("leaves icons that do not overlap where they are", () => {
    const its = items([
      [0, 0],
      [10, 0],
    ])
    const l = layoutIcons(its, 10, { side: S })
    expect(l.offsets.size).toBe(0)
    expect(l.clusters).toHaveLength(0)
  })

  it("spreads two overlapping icons apart, each under the cap", () => {
    const its = items([
      [0, 0],
      [1, 0],
    ])
    const l = layoutIcons(its, 10, { side: S })
    expect(l.clusters).toHaveLength(0)
    expect(overlaps(drawn(its, l, 10))).toBe(0)
    for (const o of l.offsets.values())
      expect(Math.hypot(o[0], o[1])).toBeLessThanOrEqual(S * CLUSTER_CAP_SIDES)
    // Symmetric: both move, opposite ways.
    const a = l.offsets.get("t0")!
    const b = l.offsets.get("t1")!
    expect(a[0]).toBeLessThan(0)
    expect(b[0]).toBeGreaterThan(0)
  })

  it("leaves no overlaps in a dense small crowd", () => {
    const its = items([
      [0, 0],
      [0.5, 0.2],
      [0.1, 0.6],
      [0.7, 0.7],
      [0.3, 0.3],
    ])
    const l = layoutIcons(its, 20, { side: S })
    expect(overlaps(drawn(its, l, 20))).toBe(0)
  })

  it("never moves an icon past the cap: it clusters instead", () => {
    // Five on one spot with a cap of half a side: no room to spread.
    const its = items([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ])
    const l = layoutIcons(its, 10, { side: S, cap: S / 2 })
    expect(l.clusters).toHaveLength(1)
    expect(l.clusters[0].members).toHaveLength(4)
    expect(overlaps(drawn(its, l, 10))).toBe(0)
  })

  it("clusters a crowd larger than the spread limit", () => {
    const its = items(Array.from({ length: 8 }, (_, i) => [i * 0.2, 0]))
    const l = layoutIcons(its, 10, { side: S })
    expect(l.clusters.length).toBeGreaterThan(0)
    expect(overlaps(drawn(its, l, 10))).toBe(0)
    // Every icon is drawn once: alone or in one cluster.
    const inClusters = l.clusters.flatMap((c) => c.members)
    expect(new Set(inClusters).size).toBe(inClusters.length)
  })

  it("is deterministic whatever the order", () => {
    const pts: [number, number][] = [
      [0, 0],
      [0.4, 0.1],
      [0.9, 0],
      [3, 3],
      [3.2, 3.1],
    ]
    const a = layoutIcons(items(pts), 30, { side: S })
    const b = layoutIcons(items(pts).reverse(), 30, { side: S })
    expect([...a.offsets].sort()).toEqual([...b.offsets].sort())
    expect(a.clusters).toEqual(b.clusters)
  })

  it("never folds in an icon from across the plan", () => {
    const its = [
      ...items(Array.from({ length: 6 }, (_, i) => [i * 0.5, 0])),
      { id: "far", c: [40, 0] as Pt },
      { id: "mid", c: [25, 0] as Pt },
    ]
    const l = layoutIcons(its, 6, { side: S })
    expect(l.clusterOf.has("far")).toBe(false)
    expect(l.clusterOf.has("mid")).toBe(false)
  })

  it("keeps a selected icon out of every cluster", () => {
    const its = items(Array.from({ length: 8 }, () => [0, 0]))
    const l = layoutIcons(its, 10, { side: S }, new Set(["t3"]))
    expect(l.clusterOf.has("t3")).toBe(false)
  })
})

describe("layoutIcons: bounds", () => {
  // A small plan: 4 x 4 cells at 10 units per cell - 40 units, a side
  // and a half of room.
  const bounds = { x: 0, y: 0, w: 40 * 2, h: 40 * 2 }
  const inside = (d: { c: Pt; side: number }) =>
    d.c[0] - d.side / 2 >= bounds.x - 1e-6 &&
    d.c[1] - d.side / 2 >= bounds.y - 1e-6 &&
    d.c[0] + d.side / 2 <= bounds.x + bounds.w + 1e-6 &&
    d.c[1] + d.side / 2 <= bounds.y + bounds.h + 1e-6

  it("spreads icons by the edge inward, not past it", () => {
    // Two racks on the left edge: an unbounded spread pushes one out.
    const its = items([
      [0.5, 3],
      [1, 3],
    ])
    const free = layoutIcons(its, 20, { side: S })
    expect(drawn(its, free, 20).every(inside)).toBe(false)
    const l = layoutIcons(its, 20, { side: S, bounds })
    expect(l.clusters).toHaveLength(0)
    const d = drawn(its, l, 20)
    expect(overlaps(d)).toBe(0)
    expect(d.every(inside)).toBe(true)
  })

  it("brings a lone icon over the edge inside", () => {
    const its = items([[0.2, 2]])
    const l = layoutIcons(its, 20, { side: S, bounds })
    expect(drawn(its, l, 20).every(inside)).toBe(true)
  })

  it("spills past the edge only when nothing fits inside", () => {
    // Room for one icon: two cannot both fit inside.
    const tiny = { x: 0, y: 0, w: 40, h: 40 }
    const its = items([
      [1, 1],
      [1.2, 1],
    ])
    const l = layoutIcons(its, 20, { side: S, bounds: tiny })
    expect(l.clusters).toHaveLength(0)
    const d = drawn(its, l, 20)
    expect(overlaps(d)).toBe(0)
    expect(d.some((x) => x.c[0] + x.side / 2 > tiny.w + 1e-6)).toBe(true)
  })
})

describe("layoutIcons: hysteresis", () => {
  it("holds a cluster together a little past where it formed", () => {
    // Eight in a row: clustered at a tight spacing.
    const row = (gap: number) =>
      items(Array.from({ length: 8 }, (_, i) => [i * gap, 0]))
    const tight = layoutIcons(row(0.1), 10, { side: S })
    expect(tight.clusters.length).toBeGreaterThan(0)
    // Just past the spacing that clusters them (side + gap = 36.4 units):
    // fresh, they would not crowd; after the tight layout they still do.
    const loose = row(3.8)
    const fresh = layoutIcons(loose, 10, { side: S })
    const held = layoutIcons(loose, 10, { side: S, prev: tight })
    expect(fresh.clusters).toHaveLength(0)
    expect(held.clusters.length).toBeGreaterThan(0)
    // Far enough apart, it lets go.
    const far = layoutIcons(row(6), 10, { side: S, prev: tight })
    expect(far.clusters).toHaveLength(0)
  })

  it("keeps the layout for zooms in one bucket", () => {
    expect(zoomBucket(1)).toBe(1)
    expect(zoomBucket(1.02)).toBe(1)
    expect(zoomBucket(1.1)).not.toBe(1)
  })
})

describe("pullOut", () => {
  it("draws a pulled-out member on its own", () => {
    const its = items(Array.from({ length: 4 }, () => [0, 0]))
    const l = layoutIcons(its, 10, { side: S, cap: 1 })
    expect(l.clusters[0].members).toHaveLength(4)
    const p = pullOut(l, new Set(["t1"]))
    expect(p.clusterOf.has("t1")).toBe(false)
    expect(p.clusters[0].members).toEqual(["t0", "t2", "t3"])
    // Leaves the layout itself untouched.
    expect(l.clusters[0].members).toHaveLength(4)
  })

  it("dissolves a cluster left with one", () => {
    const its = items([
      [0, 0],
      [0, 0],
    ])
    const l = layoutIcons(its, 10, { side: S, cap: 1 })
    expect(l.clusters).toHaveLength(1)
    const p = pullOut(l, new Set(["t0"]))
    expect(p.clusters).toHaveLength(0)
    expect(p.clusterOf.size).toBe(0)
  })
})

describe("cluster face", () => {
  it("names a run in sequence as a range", () => {
    expect(
      clusterName([
        rack("a", "R-A03", 2),
        rack("b", "R-A01", 0),
        rack("c", "R-A02", 1),
        rack("d", "R-A04", 3),
      ])
    ).toBe("R-A01–R-A04")
  })

  it("counts names out of sequence or with no shared stem", () => {
    expect(
      clusterName([
        rack("a", "R-A01", 0),
        rack("b", "R-A02", 1),
        rack("c", "R-A04", 2),
        rack("d", "R-A05", 3),
      ])
    ).toBe("4 racks")
    expect(clusterName([rack("a", "R-A01", 0), rack("b", "R-B02", 1)])).toBe(
      "2 racks"
    )
    expect(
      clusterName([
        rack("a", "R-A01", 0),
        rack("b", "sw1", 1, {
          linked: { kind: "device", id: "d", name: "sw1", role: null },
        }),
      ])
    ).toBe("2 objects")
  })

  it("wears the worst monitoring state", () => {
    expect(worstCheck([null, "degraded", "up", undefined])).toBe("degraded")
    expect(worstCheck(["degraded", "down", "stale"])).toBe("down")
    expect(worstCheck(["up", null])).toBeNull()
    const tiles = [rack("a", "R1", 0), rack("b", "R2", 1)]
    const checks: Record<string, string> = { a: "degraded", b: "stale" }
    expect(clusterFace(tiles, (t) => checks[t.id]).check).toBe("stale")
  })

  it("shares the icon of one kind, the stack when mixed", () => {
    const racks = [rack("a", "R1", 0), rack("b", "R2", 1)]
    expect(clusterFace(racks, () => null).icon).toBe("container")
    const mixed = [
      ...racks,
      rack("c", "sw", 2, {
        linked: { kind: "device", id: "d", name: "sw", role: null },
      }),
    ]
    expect(clusterFace(mixed, () => null).icon).toBe(CLUSTER_ICON)
    expect(clusterFace(mixed, () => null).count).toBe(3)
  })
})

describe("clusterFitView", () => {
  const tiles = [
    rack("a", "R1", 10),
    rack("b", "R2", 11),
    rack("c", "R3", 12),
    rack("d", "R4", 13),
  ]
  it("frames the members' extent, centred", () => {
    expect(clusterExtent(tiles)).toEqual({ x: 10, y: 10, w: 4, h: 1 })
    const v = clusterFitView(tiles, 800, 600, {
      cell: 40,
      spacingPx: 34,
      tilePx: 48,
      maxK: 3,
    })
    // Centre of the extent (12, 10.5 cells) in the viewport's middle.
    expect(12 * 40 * v.k + v.x).toBeCloseTo(400)
    expect(10.5 * 40 * v.k + v.y).toBeCloseTo(300)
  })

  it("zooms in at least until the members stop overlapping", () => {
    const v = clusterFitView(tiles, 4000, 3000, {
      cell: 40,
      spacingPx: 34,
      tilePx: 48,
      maxK: 3,
    })
    // The fit alone would do (huge viewport): k is the fit.
    expect(v.k).toBeCloseTo(Math.min((4000 - 80) / 160, 3))
    // A viewport a little small: closer than the fit, to part them
    // (34 px / 40 px a cell).
    const part = clusterFitView(tiles, 200, 200, {
      cell: 40,
      spacingPx: 34,
      tilePx: 48,
      maxK: 3,
    })
    expect(part.k).toBeCloseTo(34 / 40)
    // A tiny one: no closer than 1.15 x the fit, the extent kept in view;
    // another click parts what is still folded.
    const tiny = clusterFitView(tiles, 100, 100, {
      cell: 40,
      spacingPx: 34,
      tilePx: 48,
      maxK: 3,
    })
    expect(tiny.k).toBeCloseTo(((100 - 80) / 160) * 1.15)
  })

  it("ignores members stacked on one spot", () => {
    const stacked = [...tiles, rack("e", "sw", 10)]
    const opts = { cell: 40, spacingPx: 34, tilePx: 48, maxK: 3 }
    expect(clusterFitView(stacked, 100, 100, opts).k).toBeCloseTo(
      clusterFitView(tiles, 100, 100, opts).k
    )
  })
})

describe("layoutIcons keeps a row's order", () => {
  it("never spreads two neighbours past each other", () => {
    // Server room A from afar: four racks a cell apart, two more below.
    const items: IconItem[] = [
      { id: "R-A01", c: [76.5, 207] },
      { id: "R-A02", c: [77.5, 207] },
      { id: "R-A03", c: [78.5, 207] },
      { id: "R-A04", c: [79.5, 207] },
      { id: "R-A05", c: [76.5, 215] },
      { id: "R-A06", c: [77.5, 215] },
    ]
    let checked = 0
    for (const scale of [10, 12, 14, 16, 18, 20, 24, 28]) {
      const l = layoutIcons(items, scale, { side: S })
      const row = ["R-A01", "R-A02", "R-A03", "R-A04"]
      if (row.some((id) => l.clusterOf.has(id))) continue
      const at = (id: string) =>
        drawnCentre(l, id, items.find((i) => i.id === id)!.c, scale)
      // Side by side (not one above the other): in the row's order.
      for (let i = 0; i < row.length; i++)
        for (let j = i + 1; j < row.length; j++) {
          const a = at(row[i])
          const b = at(row[j])
          if (Math.abs(a[1] - b[1]) * scale < S)
            expect(b[0]).toBeGreaterThan(a[0])
        }
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})
