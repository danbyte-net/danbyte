import { describe, expect, it } from "vitest"

import type { FloorPlanTile, FloorPlanTray } from "@/lib/api"

import type { Pt } from "./cable-route"
import {
  CALLOUT_MAX_LEADER,
  CALLOUT_TAB_PX,
  boxGap,
  calloutClusters,
  calloutGroups,
  calloutSize,
  layoutCallouts,
  packRow,
  segmentHitsBox,
  segmentsCross,
  tileEnd,
} from "./plan-callouts"
import type { CalloutItem, PlacedCallout } from "./plan-callouts"
import { layoutPlanLabels } from "./plan-label-pass"
import type { PlanLabelInput } from "./plan-label-pass"
import { boxesHit } from "./plan-labels"
import type { Box } from "./plan-labels"
import type { AreaShape } from "./shapes"

// Callouts: a name that will not sit cleanly by its tile goes in a box off
// to the side of its room with a leader back - the boxes never overlap each
// other, a tile or a label, the leaders along a side never cross, and the
// layout is the same however often (and from wherever) it is asked for.

const anyOverlap = (boxes: readonly Box[]) =>
  boxes.some((a, i) => boxes.some((b, j) => j > i && boxesHit(a, b)))

const anyCross = (ls: readonly [Pt, Pt][]) =>
  ls.some((a, i) => ls.some((b, j) => j > i && segmentsCross(a, b)))

describe("packRow", () => {
  it("keeps boxes at their ideal centres when they fit", () => {
    expect(packRow([10, 50, 90], [20, 20, 20], 4)).toEqual([0, 40, 80])
  })

  it("spreads touching boxes about their centre, in order, gap apart", () => {
    const got = packRow([50, 50, 50], [20, 20, 20], 4)
    expect(got[1] - got[0]).toBe(24)
    expect(got[2] - got[1]).toBe(24)
    // Centred on 50: the middle box stays put.
    expect(got[1]).toBeCloseTo(40)
  })

  it("never overlaps, whatever the ideals", () => {
    const ideal = [0, 3, 5, 6, 40, 41, 120]
    const size = [30, 12, 50, 8, 20, 20, 10]
    const got = packRow(ideal, size, 6)
    for (let i = 1; i < got.length; i++)
      expect(got[i]).toBeGreaterThanOrEqual(got[i - 1] + size[i - 1] + 6 - 1e-9)
  })
})

describe("segments", () => {
  it("cross and hit boxes", () => {
    expect(
      segmentsCross(
        [
          [0, 0],
          [10, 10],
        ],
        [
          [0, 10],
          [10, 0],
        ]
      )
    ).toBe(true)
    expect(
      segmentsCross(
        [
          [0, 0],
          [10, 0],
        ],
        [
          [0, 5],
          [10, 5],
        ]
      )
    ).toBe(false)
    expect(segmentHitsBox([0, 0], [10, 10], { x: 4, y: 4, w: 2, h: 2 })).toBe(
      true
    )
    expect(segmentHitsBox([0, 0], [10, 0], { x: 4, y: 4, w: 2, h: 2 })).toBe(
      false
    )
  })
})

// A dense row of six racks in a room: the tiles 10 units wide, 2 apart.
const room: Box = { x: 0, y: 0, w: 100, h: 60 }
const row = (n = 6, y = 10): CalloutItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `R-A0${i + 1}`,
    anchor: { x: 10 + i * 12, y, w: 10, h: 20 },
    size: calloutSize(`R-A0${i + 1}`, []),
    group: "room:a",
    container: room,
  }))
const nothing = () => true

describe("layoutCallouts", () => {
  it("places a dense row above its room, without overlaps", () => {
    const items = row()
    const got = layoutCallouts(items, { free: nothing })
    expect(got.size).toBe(6)
    const placed = [...got.values()]
    expect(placed.every((p) => p.side === "top")).toBe(true)
    // Outside the room, clear of every tile and of each other.
    expect(placed.every((p) => p.box.y + p.box.h <= room.y)).toBe(true)
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false)
    for (const p of placed)
      for (const item of items) expect(boxesHit(p.box, item.anchor)).toBe(false)
  })

  it("orders the boxes as their tiles, so the leaders never cross", () => {
    const got = layoutCallouts(row(), { free: nothing })
    const placed = row().map((item) => got.get(item.id)!)
    for (let i = 1; i < placed.length; i++)
      expect(placed[i].box.x).toBeGreaterThan(placed[i - 1].box.x)
    expect(anyCross(placed.map((p) => p.leader))).toBe(false)
    // Each leader leaves from the tip of the tab in the middle of the
    // box's bottom edge and ends on its tile's edge, aimed at its centre.
    row().forEach((item, i) => {
      const { box, leader } = placed[i]
      expect(leader[0]).toEqual([
        box.x + box.w / 2,
        box.y + box.h + CALLOUT_TAB_PX,
      ])
      expect(leader[1]).toEqual(tileEnd(leader[0], item.anchor))
      const [x, y] = leader[1]
      const a = item.anchor
      const near = (p: number, q: number) => Math.abs(p - q) < 1e-6
      expect(
        near(y, a.y) || near(x, a.x) || near(x, a.x + a.w) || near(y, a.y + a.h)
      ).toBe(true)
    })
  })

  it("is the same every time, in any input order", () => {
    const a = layoutCallouts(row(), { free: nothing })
    const b = layoutCallouts([...row()].reverse(), { free: nothing })
    const flat = (m: Map<string, PlacedCallout>) =>
      [...m.values()].sort((p, q) => (p.id < q.id ? -1 : 1))
    expect(flat(b)).toEqual(flat(a))
  })

  it("splits a room's tiles to the sides nearest them", () => {
    const top = row(3, 4)
    const bottom = row(3, 36).map((item) => ({ ...item, id: `${item.id}b` }))
    const got = layoutCallouts([...top, ...bottom], { free: nothing })
    expect(top.every((item) => got.get(item.id)!.side === "top")).toBe(true)
    expect(bottom.every((item) => got.get(item.id)!.side === "bottom")).toBe(
      true
    )
    const placed = [...got.values()]
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false)
    expect(anyCross(placed.map((p) => p.leader))).toBe(false)
  })

  it("moves out past what is taken, and leaders keep off boxes", () => {
    // Something just above the room, across its width.
    const blocker: Box = { x: -50, y: -30, w: 200, h: 25 }
    const got = layoutCallouts(row(), {
      free: (b) => !boxesHit(b, blocker),
    })
    const placed = [...got.values()]
    expect(placed).toHaveLength(6)
    for (const p of placed) {
      expect(boxesHit(p.box, blocker)).toBe(false)
      for (const q of placed)
        if (q !== p)
          expect(segmentHitsBox(p.leader[0], p.leader[1], q.box)).toBe(false)
    }
  })

  it("caps the leaders: a box by its tile rather than far off", () => {
    // A site-wide area: its edge far from the tiles in the middle.
    const big: Box = { x: -1000, y: -1000, w: 2100, h: 2100 }
    const items = row(4, 20).map((it) => ({ ...it, container: big }))
    const far = layoutCallouts(items, { free: nothing })
    expect([...far.values()].every((p) => p.box.y + p.box.h <= big.y)).toBe(
      true
    )
    const near = layoutCallouts(items, {
      free: (b) => !items.some((it) => boxesHit(it.anchor, b)),
      maxLeader: CALLOUT_MAX_LEADER,
    })
    expect(near.size).toBe(4)
    const placed = [...near.values()]
    for (const p of placed)
      expect(
        Math.hypot(
          p.leader[1][0] - p.leader[0][0],
          p.leader[1][1] - p.leader[0][1]
        )
      ).toBeLessThanOrEqual(CALLOUT_MAX_LEADER)
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false)
    expect(anyCross(placed.map((p) => p.leader))).toBe(false)
    for (const p of placed)
      for (const it of items) expect(boxesHit(p.box, it.anchor)).toBe(false)
  })

  it("never crosses leaders, each box by its own tile", () => {
    // Tiles in a ring.
    const items: CalloutItem[] = Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2
      return {
        id: `T${i}`,
        anchor: {
          x: 200 + Math.cos(a) * 40,
          y: 200 + Math.sin(a) * 40,
          w: 28,
          h: 28,
        },
        size: calloutSize(`T${i}`, []),
        group: "near:T0",
        container: { x: 150, y: 150, w: 130, h: 130 },
      }
    })
    const got = layoutCallouts(items, {
      free: (b) => !items.some((it) => boxesHit(it.anchor, b)),
      maxLeader: CALLOUT_MAX_LEADER,
    })
    const placed = [...got.values()]
    expect(placed.length).toBe(8)
    expect(anyCross(placed.map((p) => p.leader))).toBe(false)
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false)
  })

  it("leaves out a tile with no free place anywhere", () => {
    const got = layoutCallouts(row(1), { free: () => false })
    expect(got.size).toBe(0)
  })
})

describe("tileEnd", () => {
  it("meets the tile's edge on the way to its centre", () => {
    const a = { x: 0, y: 0, w: 20, h: 10 }
    expect(tileEnd([10, -20], a)).toEqual([10, 0])
    expect(tileEnd([40, 5], a)).toEqual([20, 5])
    expect(tileEnd([5, 5], a)).toEqual([5, 5])
  })
})

describe("calloutClusters", () => {
  it("chains tiles near each other, the same in any order", () => {
    const tiles = [
      { id: "a", box: { x: 0, y: 0, w: 28, h: 28 } },
      { id: "b", box: { x: 40, y: 0, w: 28, h: 28 } },
      { id: "c", box: { x: 80, y: 0, w: 28, h: 28 } },
      { id: "d", box: { x: 400, y: 0, w: 28, h: 28 } },
    ]
    const g = calloutClusters(tiles, 20)
    expect(g.get("a")).toBe(g.get("c"))
    expect(g.get("d")).not.toBe(g.get("a"))
    expect(calloutClusters([...tiles].reverse(), 20)).toEqual(g)
  })
})

describe("calloutGroups", () => {
  it("goes round the smallest room, else the tiles near each other", () => {
    const tiles = [
      { id: "a", anchor: { x: 10, y: 10, w: 5, h: 5 } },
      { id: "b", anchor: { x: 300, y: 300, w: 5, h: 5 } },
      { id: "c", anchor: { x: 312, y: 300, w: 5, h: 5 } },
    ]
    const rooms = [
      { id: "hall", box: { x: 0, y: 0, w: 200, h: 200 } },
      { id: "cage", box: { x: 0, y: 0, w: 50, h: 50 } },
    ]
    const g = calloutGroups(tiles, rooms, 20, 4)
    expect(g.get("a")!.group).toBe("room:cage")
    expect(g.get("b")!.group).toBe(g.get("c")!.group)
    expect(g.get("b")!.container).toEqual({ x: 296, y: 296, w: 25, h: 13 })
  })
})

// The pass itself: racks too close to name clearly, as Server room A.
const rack = (id: string, x: number, y: number): FloorPlanTile =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 2,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: id,
    color: "#2563eb",
    status: "",
    linked: { kind: "rack", id: `r-${id}`, name: id, route: "/r" },
  }) as unknown as FloorPlanTile

const SIDE = 28
const roomArea = {
  kind: "area",
  id: "room-a",
  shape: "rect",
  x: 74,
  y: 203,
  width: 16,
  height: 20,
  rotation: 0,
  points: [],
  room: { id: "rm", name: "Server room A", code: "", color: "" },
  location: null,
  label: "",
  color: "",
  show_name: true,
} as unknown as AreaShape

function serverRoom(
  k: number,
  patch: Partial<PlanLabelInput> = {}
): PlanLabelInput {
  const scale = 40 * k
  const tiles = ["R-A01", "R-A02", "R-A03", "R-A04"].map((id, i) =>
    rack(id, 76 + i, 206)
  )
  // Each an icon of SIDE px about its centre (cells).
  const box = (t: FloorPlanTile) => {
    const s = SIDE / scale
    const c = [t.x + t.width / 2, t.y + t.height / 2]
    return { x: c[0] - s / 2, y: c[1] - s / 2, w: s, h: s }
  }
  return {
    scale,
    unitsPerPx: 1,
    font: 11,
    chipFont: 10,
    repeat: 280,
    gap: 4,
    bounds: { x: 0, y: 0, w: 495 * scale, h: 427 * scale },
    tiles,
    shapeOf: (t) => ({
      box: box(t),
      grow: 2,
      changed: true,
      symbol: true,
    }),
    iconIds: new Set(tiles.map((t) => t.id)),
    areas: [roomArea],
    cellMm: 600,
    callouts: {},
    ...patch,
  }
}

describe("layoutPlanLabels with callouts", () => {
  it("names a whole cluster in callouts, never mixed with plain names", () => {
    // Far out: a rack ~1 cell is 10 px, its icon 28 px - they touch. The
    // middle two have a neighbour either side; the ends' names would fit,
    // but the row is one cluster: all four in callouts.
    const got = layoutPlanLabels(serverRoom(0.75))
    expect(got.callouts.map((c) => c.id).sort()).toEqual([
      "R-A01",
      "R-A02",
      "R-A03",
      "R-A04",
    ])
    expect(got.tiles).toEqual([])
    expect(got.tileNamesHere.has("R-A02")).toBe(true)
    // Leaders capped, boxes never overlapping, no leader crossing another.
    const scale = 40 * 0.75
    for (const c of got.callouts)
      expect(
        Math.hypot(
          (c.leader[1][0] - c.leader[0][0]) * scale,
          (c.leader[1][1] - c.leader[0][1]) * scale
        )
      ).toBeLessThanOrEqual(CALLOUT_MAX_LEADER + 1e-6)
    const boxes = got.callouts.map((c) => ({
      x: c.at[0] * scale - c.size.w / 2,
      y: c.at[1] * scale - c.size.h / 2,
      w: c.size.w,
      h: c.size.h,
    }))
    expect(anyOverlap(boxes)).toBe(false)
    expect(
      anyCross(
        got.callouts.map((c) => [
          [c.leader[0][0] * scale, c.leader[0][1] * scale],
          [c.leader[1][0] * scale, c.leader[1][1] * scale],
        ])
      )
    ).toBe(false)
  })

  it("keeps a tile apart from the cluster plain", () => {
    // R-A09 far along the row: a cluster of its own, its name clear.
    const tiles = [...serverRoom(0.75).tiles, rack("R-A09", 88, 206)]
    const got = layoutPlanLabels(serverRoom(0.75, { tiles }))
    expect(got.callouts.map((c) => c.id)).not.toContain("R-A09")
    expect(got.callouts.length).toBe(4)
    expect(got.tiles.map((t) => t.id)).toEqual(["R-A09"])
  })

  it("keeps plain names where they sit clearly", () => {
    // Spread out (racks 5 cells apart): every name fits by its icon.
    const tiles = ["R-A01", "R-A02"].map((id, i) => rack(id, 76 + i * 8, 206))
    const got = layoutPlanLabels(serverRoom(0.75, { tiles }))
    expect(got.callouts).toEqual([])
    expect(got.tiles.map((t) => t.id).sort()).toEqual(["R-A01", "R-A02"])
  })

  it("off: no callouts", () => {
    const got = layoutPlanLabels(serverRoom(0.75, { callouts: null }))
    expect(got.callouts).toEqual([])
  })

  it("never moves a callout as the view pans", () => {
    const scale = 40 * 0.75
    const a = layoutPlanLabels(
      serverRoom(0.75, {
        view: { x: 70 * scale, y: 190 * scale, w: 800, h: 600 },
      })
    )
    const b = layoutPlanLabels(
      serverRoom(0.75, {
        view: { x: 60 * scale, y: 180 * scale, w: 900, h: 700 },
      })
    )
    expect(b.callouts).toEqual(a.callouts)
    expect(a.callouts.length).toBe(4)
  })

  it("carries the chosen lines and sizes the box for them", () => {
    const lines = new Map([
      [
        "R-A02",
        [
          { key: "status", label: "Status", value: "Active", color: "#22c55e" },
          { key: "facility_id", label: "Facility ID", value: "FAC-0002" },
        ],
      ],
    ])
    const got = layoutPlanLabels(serverRoom(0.75, { callouts: { lines } }))
    const c = got.callouts.find((x) => x.id === "R-A02")!
    expect(c.lines.map((l) => l.key)).toEqual(["status", "facility_id"])
    const plain = got.callouts.find((x) => x.id === "R-A03")!
    expect(c.size.h).toBeGreaterThan(plain.size.h)
  })

  it("keeps a tray's name and the room's name off the icons", () => {
    const scale = 40 * 0.75
    const tray = {
      id: "t1",
      name: "OH-A1",
      color: "",
      points: [
        [75, 205],
        [89, 205],
      ] as Pt[],
      level: "overhead",
      elevation_mm: null,
      cables: Array.from({ length: 8 }, (_, i) => `${i}`),
      hidden_cable_count: 0,
    } as unknown as FloorPlanTray
    const input = serverRoom(0.75, { trays: [tray], trayWidth: 4 })
    const got = layoutPlanLabels(input)
    const icons = input.tiles.map((t) => {
      const b = input.shapeOf!(t)!.box
      return { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale }
    })
    for (const tl of got.trays) {
      const w = tl.text.length * 11 * 0.6
      const tb = {
        x: tl.at[0] * scale - w / 2,
        y: tl.at[1] * scale - 6,
        w,
        h: 12,
      }
      expect(icons.some((i) => boxGap(i, tb) === 0 && boxesHit(i, tb))).toBe(
        false
      )
    }
    // Neither a name nor a tray's under a callout box.
    const boxes = got.callouts.map((c) => ({
      x: c.at[0] * scale - c.size.w / 2,
      y: c.at[1] * scale - c.size.h / 2,
      w: c.size.w,
      h: c.size.h,
    }))
    for (const tl of got.trays)
      for (const b of boxes)
        expect(
          boxesHit(b, {
            x: tl.at[0] * scale - 1,
            y: tl.at[1] * scale - 1,
            w: 2,
            h: 2,
          })
        ).toBe(false)
  })
})
