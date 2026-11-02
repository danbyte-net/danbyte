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
  for (const it of items) {
    if (l.clusterOf.has(it.id)) continue
    const c = drawnCentre(l, it.id, it.c, scale)
    out.push({ id: it.id, c: [c[0] * scale, c[1] * scale], side: S })
  }
  for (const c of l.clusters) {
    const p = drawnCentre(l, c.id, c.anchor, scale)
    out.push({ id: c.id, c: [p[0] * scale, p[1] * scale], side: S * CLUSTER_SIDE })
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

  it("keeps a selected icon out of every cluster", () => {
    const its = items(Array.from({ length: 8 }, () => [0, 0]))
    const l = layoutIcons(its, 10, { side: S }, new Set(["t3"]))
    expect(l.clusterOf.has("t3")).toBe(false)
  })
})

describe("layoutIcons: hysteresis", () => {
  it("holds a cluster together a little past where it formed", () => {
    // Eight in a row: clustered at a tight spacing.
    const row = (gap: number) =>
      items(Array.from({ length: 8 }, (_, i) => [i * gap, 0]))
    const tight = layoutIcons(row(0.1), 10, { side: S })
    expect(tight.clusters.length).toBeGreaterThan(0)
    // Just past the spacing that clusters them (side + gap = 33.6 units):
    // fresh, they would not crowd; after the tight layout they still do.
    const loose = row(3.5)
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
    expect(
      clusterName([rack("a", "R-A01", 0), rack("b", "R-B02", 1)])
    ).toBe("2 racks")
    expect(
      clusterName([
        rack("a", "R-A01", 0),
        rack("b", "sw1", 1, {
          linked: { kind: "device", id: "d", name: "sw1", role: null },
        } as Partial<FloorPlanTile>),
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
      } as Partial<FloorPlanTile>),
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
    const close = clusterFitView(tiles, 100, 100, {
      cell: 40,
      spacingPx: 34,
      tilePx: 48,
      maxK: 3,
    })
    // A tiny viewport: still close enough to part them (34 px / 40 px).
    expect(close.k).toBeCloseTo(34 / 40)
  })
})
