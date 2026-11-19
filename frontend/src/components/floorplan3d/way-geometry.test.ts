import { describe, expect, it } from "vitest"

import {
  bundles,
  fillColor,
  fillShare,
  managerLanes,
  pathwayFills,
  rackFrameM,
  rackLanes,
  rackLocal,
  rackWayExits,
  underRoof,
  wayDiameterMm,
  wayLod,
  wayRun,
} from "./way-geometry"
import type {
  ManagerGeo,
  PortAnchor,
  ScenePathway,
  SceneWay,
  Vec3,
} from "./way-geometry"
import type { SceneRack } from "./world"

const DEPTH = 1
const HEIGHT = 2.0
const BASE = 0.1
const TOP_UNIT = BASE + 42 * 0.04445

function manager(
  key: string,
  side: "left" | "right",
  face: "front" | "rear",
  over: Partial<ManagerGeo> = {}
): ScenePathway {
  const sign = side === "left" ? -1 : 1
  const y0 = face === "front" ? 145 : 885
  return {
    key,
    id: null,
    source: "kit",
    kind: "vertical",
    subkind: "channel",
    side,
    face,
    surface: "",
    u_from: 1,
    u_to: 42,
    inner_w_mm: 52,
    inner_d_mm: 88,
    fill_limit_pct: 40,
    label: key,
    addon: false,
    geo: {
      x0: sign > 0 ? 245 : -299,
      x1: sign > 0 ? 299 : -245,
      y0,
      y1: y0 + 90,
      z0: 100,
      z1: TOP_UNIT * 1000,
      cx: sign * 271,
      cy: y0 + 45,
      wall: 1,
      open: "front",
      pitch_mm: null,
      ...over,
    },
  }
}

const ROOF: ScenePathway = {
  key: "entry:top:front-left",
  id: null,
  source: "kit",
  kind: "entry",
  subkind: "brush",
  side: "",
  face: "",
  surface: "top",
  u_from: null,
  u_to: null,
  inner_w_mm: 200,
  inner_d_mm: 80,
  fill_limit_pct: 40,
  label: "Roof front-left",
  addon: false,
  geo: { x: -168, y: 100, z: HEIGHT * 1000, w: 200, d: 80 },
}

const LEFT = manager("path:vertical:left:front", "left", "front")
const PATHWAYS = new Map([LEFT, ROOF].map((p) => [p.key, p]))

function way(id: string, over: Partial<SceneWay> = {}): SceneWay {
  return {
    id: `w-${id}`,
    cable_id: id,
    label: id,
    color: "#2563eb",
    type: "cat6",
    outer_diameter_mm: null,
    end: "A",
    state: "recorded",
    source: "auto",
    exit: "top",
    hops: [
      { key: LEFT.key, kind: "vertical", enter_u: 20, leave_u: 42 },
      { key: ROOF.key, kind: "entry", enter_u: null, leave_u: null },
    ],
    length_mm: 1200,
    ends: [{ end: "A", device: "d1", port: "Gi1/0/1", kind: "interface" }],
    ...over,
  }
}

/** A port at U20 on the front face, a little left of centre (rack frame). */
const U20 = BASE + 19.5 * 0.04445
const PORT: PortAnchor = {
  p: [0.1, U20, -DEPTH / 2 + 0.08],
  stub: [0.1, U20, -DEPTH / 2 + 0.02],
}

function run(w: SceneWay, start = PORT, far: PortAnchor | null = null) {
  const lanes = rackLanes(PATHWAYS, [w])
  return wayRun({
    depthM: DEPTH,
    heightM: HEIGHT,
    baseM: BASE,
    topUnitM: TOP_UNIT,
    pathways: PATHWAYS,
    way: w,
    lanes,
    start,
    far,
  })
}

const near = (a: Vec3, b: Vec3, tol = 1e-6) =>
  a.every((v, i) => Math.abs(v - b[i]) < tol)

describe("rackLocal", () => {
  it("turns rack mm into the rack group's frame", () => {
    // x right of centre seen from the front is the group's −x; y behind
    // the front from the front plane at −depth/2; z is height.
    expect(rackLocal(1, 271, 190, 500)).toEqual([-0.271, 0.5, -0.31])
  })
})

describe("managerLanes", () => {
  const cables = Array.from({ length: 30 }, (_, i) => ({
    id: `c${String(i).padStart(2, "0")}`,
    dia: 6.1,
  }))
  const lanes = managerLanes(52, 88, "front", cables)

  it("keeps every lane inside the manager's inner cross-section", () => {
    for (const c of cables) {
      const l = lanes.get(c.id)!
      expect(Math.abs(l.u) + c.dia / 2).toBeLessThanOrEqual(26 + 1e-9)
      expect(Math.abs(l.v) + c.dia / 2).toBeLessThanOrEqual(44 + 1e-9)
    }
  })

  it("never overlaps two lanes of one layer", () => {
    const first = cables
      .map((c) => lanes.get(c.id)!)
      .filter((l) => l.layer === 0)
    expect(first.length).toBe(30)
    for (let i = 0; i < first.length; i++)
      for (let j = i + 1; j < first.length; j++)
        expect(
          Math.hypot(first[i].u - first[j].u, first[i].v - first[j].v)
        ).toBeGreaterThanOrEqual(6.1)
  })

  it("is deterministic and fills from the wall away from the open side", () => {
    const again = managerLanes(52, 88, "front", [...cables].reverse())
    expect([...again.entries()].sort()).toEqual([...lanes.entries()].sort())
    // Open at the front: the first cable lies at the rear wall (+v).
    expect(lanes.get("c00")!.v).toBeGreaterThan(30)
  })

  it("repeats lanes in layers past the cross-section", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      dia: 6,
    }))
    const got = managerLanes(20, 20, "front", many)
    expect(Math.max(...[...got.values()].map((l) => l.layer))).toBeGreaterThan(
      0
    )
  })
})

describe("wayRun", () => {
  it("enters the manager at the port's unit, in its lane", () => {
    const w = way("c1")
    const r = run(w)
    const lane = rackLanes(PATHWAYS, [w]).get(LEFT.key)!.get("c1")!
    const [lx, , lz] = rackLocal(DEPTH, 271 * -1 + lane.u, 190 + lane.v, 0)
    // Along the face at the port's height to the manager, then into it.
    expect(r.points.some((p) => near(p, [lx, U20, PORT.stub[2]]))).toBe(true)
    expect(r.points.some((p) => near(p, [lx, U20, lz]))).toBe(true)
    // Up the manager to its top, then under the roof to the entry.
    expect(r.spans).toEqual([
      { key: LEFT.key, y0: U20, y1: TOP_UNIT, at: [lx, lz] },
    ])
  })

  it("leaves through its entry, above the roof", () => {
    const r = run(way("c1"))
    const exit = r.exit!
    expect(exit[1]).toBeGreaterThan(HEIGHT)
    expect(r.points.at(-1)).toEqual(exit)
    // Crossing under the roof, above the top unit.
    const under = underRoof(TOP_UNIT, HEIGHT)
    expect(under).toBeGreaterThan(TOP_UNIT)
    expect(under).toBeLessThan(HEIGHT)
    expect(r.points.some((p) => Math.abs(p[1] - under) < 1e-9)).toBe(true)
  })

  it("runs square: no leg moves along all three axes", () => {
    for (const leg of pairs(run(way("c1")).points)) {
      const moved = [0, 1, 2].filter(
        (i) => Math.abs(leg[1][i] - leg[0][i]) > 1e-9
      )
      expect(moved.length).toBeLessThanOrEqual(2)
    }
  })

  it("ends at the far port when both ends are in the rack", () => {
    const w = way("c2", {
      end: "AB",
      exit: "port",
      hops: [{ key: LEFT.key, kind: "vertical", enter_u: 20, leave_u: 30 }],
    })
    const far: PortAnchor = {
      p: [0.15, BASE + 29.5 * 0.04445, -DEPTH / 2 + 0.08],
      stub: [0.15, BASE + 29.5 * 0.04445, -DEPTH / 2 + 0.02],
    }
    const r = run(w, PORT, far)
    expect(r.points.at(-1)).toEqual(far.p)
    expect(r.exit).toBeNull()
  })

  it("skips a hop whose pathway the rack no longer shows", () => {
    const w = way("c3", {
      hops: [
        {
          key: "path:vertical:right:front",
          kind: "vertical",
          enter_u: 20,
          leave_u: 42,
        },
        { key: ROOF.key, kind: "entry", enter_u: null, leave_u: null },
      ],
    })
    expect(run(w).exit).not.toBeNull()
  })
})

describe("rackWayExits", () => {
  it("is where the rack's run leaves, so the room's carries on there", () => {
    const w = way("c1")
    const rack = {
      id: "r",
      name: "R",
      u_height: 42,
      starting_unit: 1,
      desc_units: false,
      width: 19,
      outer_width_mm: 600,
      outer_depth_mm: 1000,
      devices: [],
      pathways: [LEFT, ROOF],
      ways: [w, way("c9", { end: "AB", exit: "port" })],
    } as unknown as SceneRack
    const exits = rackWayExits(rack)
    expect([...exits.keys()]).toEqual(["c1|A"])
    // Whatever port it starts at.
    const other = wayRun({
      ...rackFrameM(rack),
      pathways: PATHWAYS,
      way: w,
      lanes: rackLanes(PATHWAYS, [w]),
      start: { p: [-0.2, 0.5, -0.4], stub: [-0.2, 0.5, -0.45] },
    })
    const at = exits.get("c1|A")!
    expect(at[1]).toBeCloseTo(other.exit![1], 9)
    expect(at[0]).toBeCloseTo(other.exit![0], 9)
    expect(at[2]).toBeCloseTo(other.exit![2], 9)
  })
})

describe("bundles and LOD", () => {
  it("draws cables up close, bundles further off", () => {
    expect(wayLod("detail")).toBe("cables")
    expect(wayLod("mid")).toBe("bundles")
    expect(wayLod("far")).toBe("bundles")
  })

  it("packs a manager's cables in one tube no wider than its inside", () => {
    const runs = Array.from({ length: 400 }, (_, i) => {
      const r = run(way(`c${i}`))
      return { spans: r.spans, dia: 6.1, color: i % 3 ? "#2563eb" : "#eab308" }
    })
    const [b] = bundles(DEPTH, PATHWAYS, runs)
    expect(b.count).toBe(400)
    expect(b.radius * 2000).toBeLessThanOrEqual(52 + 1e-6)
    expect(b.color).toBe("#2563eb")
    const few = bundles(DEPTH, PATHWAYS, runs.slice(0, 4))[0]
    expect(few.radius).toBeLessThan(b.radius)
  })
})

describe("fill", () => {
  it("is the cables' area over the usable area, indicatively", () => {
    // 52 × 88 mm at 40 %: 1830 mm²; twenty Cat6 (29.2 mm² each) ≈ 32 %.
    const share = fillShare(52, 88, 40, Array(20).fill(6.1))
    expect(share).toBeCloseTo(
      (20 * Math.PI * 6.1 ** 2) / 4 / (52 * 88 * 0.4),
      9
    )
    expect(fillColor(share)).toBe("#16a34a")
    expect(fillColor(0.8)).toBe("#d97706")
    expect(fillColor(1.2)).toBe("#dc2626")
  })

  it("counts only recorded ways", () => {
    const ways = Array.from({ length: 70 }, (_, i) =>
      way(`c${i}`, { state: i < 10 ? "recorded" : "proposed" })
    )
    expect(pathwayFills(PATHWAYS, ways).get(LEFT.key)).toBe("#16a34a")
    const all = ways.map((w) => ({ ...w, state: "recorded" as const }))
    expect(pathwayFills(PATHWAYS, all).get(LEFT.key)).toBe("#dc2626")
  })

  it("takes a cable's own diameter, else its type's", () => {
    expect(wayDiameterMm("cat6")).toBe(6.1)
    expect(wayDiameterMm("smf")).toBe(3)
    expect(wayDiameterMm("power")).toBe(8)
    expect(wayDiameterMm("cat6", 7.2)).toBe(7.2)
  })
})

function pairs(points: readonly Vec3[]): [Vec3, Vec3][] {
  return points.slice(1).map((p, i) => [points[i], p])
}
