import { describe, expect, it } from "vitest"

import type { FloorPlanCablePath } from "@/lib/api"
import { cableEndsAnchored, cableRunPoints } from "./cable-trace-3d"
import { OUTLINE_NEUTRAL, cabinetOutline } from "./cabinet-mesh"
import {
  boxEdgesM,
  cabinetBoxM,
  cellToWorld,
  freeAirRideY,
  tallestRackTopM,
} from "./world"
import type { SceneCabinet, ScenePayload, SceneTile } from "./world"

// A DIN-rail cabinet in the 3D room: a closed box at its outer size, its
// outline in the monitoring colours, and the cables to its devices ending on
// the box.

const plan: ScenePayload["plan"] = {
  id: "p",
  name: "Serverrum A",
  grid_width: 12,
  grid_height: 8,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
}

const cabinet = (patch: Partial<SceneCabinet> = {}): SceneCabinet => ({
  id: "c1",
  name: "K1",
  outer_width_mm: 550,
  outer_height_mm: 650,
  outer_depth_mm: 200,
  device_count: 5,
  ...patch,
})

const tile = (
  id: string,
  x: number,
  patch: Partial<SceneTile> = {}
): SceneTile => ({
  id,
  x,
  y: 2,
  w: 1,
  h: 1,
  orientation: 0,
  status: "",
  label: "",
  kind: "cabinet",
  color: "",
  is_zone: false,
  rack: null,
  cabinet: cabinet({ id: `c-${id}` }),
  ...patch,
})

const sceneOf = (...tiles: SceneTile[]) =>
  ({ plan, tiles, trays: [], raised_floors: [] }) as unknown as ScenePayload

describe("cabinetBoxM", () => {
  it("is the outer size in metres: width across, depth back, height up", () => {
    const b = cabinetBoxM(cabinet())
    expect(b.width).toBeCloseTo(0.55)
    expect(b.height).toBeCloseTo(0.65)
    expect(b.depth).toBeCloseTo(0.2)
  })

  it("never collapses to nothing", () => {
    const b = cabinetBoxM(
      cabinet({ outer_width_mm: 0, outer_height_mm: 0, outer_depth_mm: 0 })
    )
    expect(b.width).toBeGreaterThan(0)
    expect(b.height).toBeGreaterThan(0)
    expect(b.depth).toBeGreaterThan(0)
  })
})

describe("boxEdgesM", () => {
  const edges = boxEdgesM(0.55, 0.65, 0.2)

  it("draws the box's twelve edges as point pairs", () => {
    expect(edges).toHaveLength(24)
    // Each pair is one straight edge: exactly one axis changes.
    for (let i = 0; i < edges.length; i += 2) {
      const [a, b] = [edges[i], edges[i + 1]]
      const moved = [0, 1, 2].filter((k) => Math.abs(a[k] - b[k]) > 1e-9)
      expect(moved).toHaveLength(1)
    }
  })

  it("stands on the floor, centred on its tile", () => {
    const xs = edges.map((p) => p[0])
    const ys = edges.map((p) => p[1])
    const zs = edges.map((p) => p[2])
    expect(Math.min(...xs)).toBeCloseTo(-0.275)
    expect(Math.max(...xs)).toBeCloseTo(0.275)
    expect(Math.min(...ys)).toBe(0)
    expect(Math.max(...ys)).toBeCloseTo(0.65)
    expect(Math.min(...zs)).toBeCloseTo(-0.1)
    expect(Math.max(...zs)).toBeCloseTo(0.1)
  })
})

describe("cabinetOutline", () => {
  it("carries the monitoring state in the racks' beacon colours", () => {
    expect(cabinetOutline("down")).toEqual({ color: "#ef4444", width: 2.5 })
    expect(cabinetOutline("degraded").color).toBe("#f59e0b")
    expect(cabinetOutline("up").color).toBe("#10b981")
  })

  it("is a plain edge with nothing to report", () => {
    expect(cabinetOutline(null)).toEqual({ color: OUTLINE_NEUTRAL, width: 1 })
    expect(cabinetOutline("unknown").color).toBe(OUTLINE_NEUTRAL)
  })
})

describe("a tray-less run clears cabinets too", () => {
  it("counts a tall cabinet as the room's tallest top", () => {
    const tall = tile("t1", 2, {
      cabinet: cabinet({ outer_height_mm: 2200 }),
    })
    const s = sceneOf(tall)
    expect(tallestRackTopM(s)).toBeCloseTo(2.2)
    expect(freeAirRideY(s)).toBeGreaterThan(2.2)
  })
})

describe("cables to a cabinet's devices", () => {
  const a = tile("ta", 2)
  const b = tile("tb", 8)
  const path = (
    aTile: string,
    bTile: string,
    id = "cable-1"
  ): FloorPlanCablePath => ({
    id,
    label: "",
    color: "",
    type: "cat6",
    a_tiles: [aTile],
    b_tiles: [bTile],
    a_points: [{ device: "plc-1", port: "eth0" }],
    b_points: [{ device: "io-1", port: "eth0" }],
    tray_ids: [],
  })

  it("end on top of each cabinet's box, at its tile", () => {
    const s = sceneOf(a, b)
    const pts = cableRunPoints(s, new Map(), path("ta", "tb"))!
    expect(pts).not.toBeNull()
    const first = pts[0]
    const last = pts[pts.length - 1]
    const [ax, az] = cellToWorld(plan, a.x + 0.5, a.y + 0.5)
    const [bx, bz] = cellToWorld(plan, b.x + 0.5, b.y + 0.5)
    // On the lid: the box's height, within its footprint.
    expect(first[1]).toBeCloseTo(0.65)
    expect(Math.abs(first[0] - ax)).toBeLessThan(0.275)
    expect(first[2]).toBeCloseTo(az)
    expect(last[1]).toBeCloseTo(0.65)
    expect(Math.abs(last[0] - bx)).toBeLessThan(0.275)
    expect(last[2]).toBeCloseTo(bz)
    // And rises from there: never down through the floor.
    expect(Math.min(...pts.map((p) => p[1]))).toBeGreaterThan(0.6)
  })

  it("count as anchored - the run is where the cabinet is", () => {
    expect(cableEndsAnchored(sceneOf(a, b), path("ta", "tb"))).toEqual([
      true,
      true,
    ])
  })

  it("stay inside the box between two devices in one cabinet", () => {
    expect(cableRunPoints(sceneOf(a), new Map(), path("ta", "ta"))).toBeNull()
  })

  it("keep apart on the lid, each in its own lane", () => {
    const s = sceneOf(a, b)
    const xs = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6"].map(
      (id) => cableRunPoints(s, new Map(), path("ta", "tb", id))![0][0]
    )
    expect(new Set(xs.map((x) => x.toFixed(4))).size).toBeGreaterThan(1)
  })
})
