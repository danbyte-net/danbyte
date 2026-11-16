import { describe, expect, it } from "vitest"

import { CORD_STUB_M, CordEndStore, tightestBend } from "@/lib/cord-run"
import type { CordEnd } from "@/lib/cord-run"
import { FIBRE_COLOURS } from "@/lib/fibre-colours"

import {
  cableEndsAnchored,
  cableRun,
  cableRunPoints,
  runColor,
  runProfile,
} from "./cable-trace-3d"
import {
  cellToWorld,
  rackOpeningM,
  type SceneDevice,
  type ScenePayload,
  type SceneRack,
  type SceneTile,
} from "./world"

const plan: ScenePayload["plan"] = {
  id: "p",
  name: "Hall",
  grid_width: 24,
  grid_height: 16,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
}

const marks = (names: string[]) =>
  names.map((name, i) => ({
    kind: "rj45",
    name,
    x: 0.1 + i * 0.2,
    y: 0.5,
    w: 0.03,
    h: 0.2,
  }))

const dev = (
  id: string,
  position: number,
  over: Partial<SceneDevice> = {}
): SceneDevice => ({
  id,
  name: id,
  position,
  face: "",
  rack_side: "",
  u_height: 1,
  rack_width: "full",
  is_full_depth: true,
  role_color: "",
  role_name: "",
  device_type: "",
  status: null,
  primary_ip: null,
  serial_number: "",
  front_image: null,
  rear_image: null,
  has_faceplate: false,
  image_ports: null,
  ...over,
})

// An 800 mm cabinet: the wall is 16 cm past each rail edge, which is
// exactly the gap the old channel placement put the lead into.
const rack: SceneRack = {
  id: "r",
  name: "R01",
  u_height: 42,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  outer_width_mm: 800,
  outer_depth_mm: 1000,
  devices: [
    dev("sw", 40, {
      image_ports: { front: marks(["Gi1", "Gi2", "Gi3", "Gi4"]), rear: [] },
    }),
    dev("srv", 20, {
      u_height: 2,
      image_ports: { front: [], rear: marks(["eth0", "eth1"]) },
    }),
    dev("bare", 10),
  ],
}
const tile: SceneTile = {
  id: "t",
  x: 4,
  y: 4,
  w: 1,
  h: 2,
  orientation: 0,
  status: "",
  label: "",
  kind: "rack",
  color: "",
  is_zone: false,
  rack,
} as SceneTile
const scene = {
  plan,
  tiles: [tile],
  trays: [],
  raised_floors: [],
} as unknown as ScenePayload
const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)

const path = (a: [string, string], b: [string, string]) => ({
  id: "c1",
  label: "",
  color: "",
  type: "cat6",
  a_tiles: ["t"],
  b_tiles: ["t"],
  a_points: [{ device: a[0], port: a[1] }],
  b_points: [{ device: b[0], port: b[1] }],
  tray_ids: [],
})

describe("same-rack cable runs", () => {
  it("dress at the rail, not at the cabinet wall, and stay near the face", () => {
    const pts = cableRunPoints(
      scene,
      new Map([
        ["sw", { tile, devIndex: 0 }],
        ["srv", { tile, devIndex: 1 }],
      ]),
      path(["sw", "Gi1"], ["srv", "eth0"])
    )!
    expect(pts.length).toBeGreaterThan(4)
    const reach = Math.max(...pts.map((p) => Math.abs(p[0] - cx)))
    // The rail edge plus the 2 cm channel plus at most half the lane spread.
    expect(reach).toBeLessThan(rackOpeningM(rack) / 2 + 0.02 + 0.1)
    // Never out at the old cabinet-wall channel (0.4 m + 4 cm).
    expect(reach).toBeLessThan(0.8 / 2)
    // Depth: within the cabinet's depth plus the 6 cm stub on either face.
    const depth = Math.max(...pts.map((p) => Math.abs(p[2] - cz)))
    expect(depth).toBeLessThan(1.0 / 2 + 0.07)
  })

  it("wrap the side nearer both ports", () => {
    const sites = new Map([
      ["sw", { tile, devIndex: 0 }],
      ["srv", { tile, devIndex: 1 }],
    ])
    // Gi4 sits on the right of the switch face, eth1 on the right of the
    // server's rear (mirrored when viewed from the front) - the midpoint
    // decides, so the run must not wrap the far edge.
    const right = cableRunPoints(
      scene,
      sites,
      path(["sw", "Gi4"], ["srv", "eth0"])
    )!
    const xs = right.map((p) => p[0] - cx)
    const wrapX = xs.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0)
    const midX = (xs[0] + xs[xs.length - 1]) / 2
    expect(Math.sign(wrapX)).toBe(Math.sign(midX) || Math.sign(wrapX))
  })

  it("report which ends found a marker", () => {
    expect(
      cableEndsAnchored(scene, path(["sw", "Gi1"], ["srv", "eth0"]))
    ).toEqual([true, true])
    expect(
      cableEndsAnchored(scene, path(["sw", "Gi1"], ["bare", "eth0"]))
    ).toEqual([true, false])
  })
})

describe("runs from a cord", () => {
  const sites = new Map([
    ["sw", { tile, devIndex: 0 }],
    ["srv", { tile, devIndex: 1 }],
  ])
  const fibre = { ...path(["sw", "Gi1"], ["srv", "eth0"]), type: "smf-os2" }
  const plain = cableRunPoints(scene, sites, fibre)!
  // The cord's cable empty: 5 cm out of the switch's port, along the
  // stub's direction (the port's face is the rack's front, −Z here).
  const out = Math.sign(plain[1][2] - plain[0][2]) || -1
  const cord = (over: Partial<CordEnd> = {}): CordEnd => ({
    at: [plain[0][0], plain[0][1], plain[0][2] + out * 0.05],
    x: [1, 0, 0],
    y: [0, 1, 0],
    z: [0, 0, out],
    scale: 1,
    cable: {
      profile: "zipcord",
      jacket_mm: 1.8,
      pitch_mm: 1.84,
      min_bend_mm: 30,
    },
    ...over,
  })

  it("start at the cord's cable empty and leave along its +Z", () => {
    const store = new CordEndStore()
    const c = cord()
    store.setDevice("sw", new Map([["Gi1", c]]))
    const run = cableRun(scene, sites, fibre, store)!
    expect(run.a).toEqual(c)
    expect(run.b).toBeNull()
    expect(run.points[0]).toEqual(c.at)
    // The first step is along the empty's +Z (within the arc's first
    // sixteenth of a half turn): the run continues the stub.
    const d = run.points[1].map((v, i) => v - c.at[i])
    expect(Math.sign(d[2])).toBe(out)
    expect(Math.hypot(d[0], d[1]) / Math.abs(d[2])).toBeLessThan(
      Math.tan(Math.PI / 32) + 1e-9
    )
    expect(Math.hypot(...d)).toBeLessThanOrEqual(CORD_STUB_M + 1e-9)
    // The far end is as before.
    expect(run.points[run.points.length - 1]).toEqual(plain[plain.length - 1])
    // A cable without a drawn cord is unchanged.
    expect(cableRunPoints(scene, sites, fibre, new CordEndStore())).toEqual(
      plain
    )
  })

  it("bend no tighter than the cord's minimum where there is room", () => {
    const store = new CordEndStore()
    store.setDevice("sw", new Map([["Gi1", cord()]]))
    const run = cableRun(scene, sites, fibre, store)!
    expect(tightestBend(run.points)).toBeGreaterThan(0.03 * 0.999)
  })

  it("draw a zip cord at life size, in the fibre's colour", () => {
    const store = new CordEndStore()
    store.setDevice("sw", new Map([["Gi1", cord()]]))
    const run = cableRun(scene, sites, fibre, store)!
    const p = runProfile(run, 2)!
    expect(p.kind).toBe("zipcord")
    if (p.kind !== "zipcord") return
    expect(p.radius).toBeCloseTo(0.0018)
    expect(p.pitch).toBeCloseTo(0.00368)
    expect(p.startUp).toEqual([0, 1, 0])
    expect(p.endUp).toBeNull()
    expect(runColor(fibre, run)).toBe(FIBRE_COLOURS.yellow)
    expect(runColor({ ...fibre, color: "#123456" }, run)).toBe("#123456")
    // No cord: the cable's grey as before, and no profile.
    const bare = cableRun(scene, sites, fibre)!
    expect(runProfile(bare)).toBeNull()
    expect(runColor(fibre, bare)).toBe("#64748b")
  })
})
