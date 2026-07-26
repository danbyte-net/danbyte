import { describe, expect, it } from "vitest"

import {
  APPLIANCE_D_FRAC,
  APPLIANCE_H_U,
  APPLIANCE_W_FRAC,
  CABLE_LANES,
  CABLE_LANE_SPACING_M,
  DOOR_DEFAULT_MM,
  RACK_BASE_M,
  airflowGlyphPlacements,
  cableLane,
  cableRadiusM,
  cellToWorld,
  deviceBoxM,
  deviceYM,
  filletPath,
  offsetPolyline,
  rackFootprintM,
  rackViewpoint,
  sideStripBoxM,
  trayElevationM,
  underfloorMM,
  wallDoorSpans,
  wallSegmentsWithOpenings,
  type SceneRack,
  type SceneTray,
  type ScenePayload,
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

const rack = (over: Partial<SceneRack> = {}): SceneRack => ({
  id: "r",
  name: "R01",
  u_height: 42,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  outer_width_mm: null,
  outer_depth_mm: null,
  devices: [],
  ...over,
})

const dev = (position: number, u = 1, over = {}) => ({
  id: "d",
  name: "sw",
  position,
  face: "" as const,
  rack_side: "" as const,
  u_height: u,
  rack_width: "full" as const,
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

describe("cellToWorld", () => {
  it("maps cells to metres via cell_mm", () => {
    expect(cellToWorld(plan, 10, 5)).toEqual([6, 3])
  })
})

describe("deviceYM — must mirror the 2D elevation's unit math exactly", () => {
  it("ascending units: U1 sits on the base, U42 at the top", () => {
    const r = rack()
    const u1 = deviceYM(r, dev(1))
    expect(u1.y).toBeCloseTo(RACK_BASE_M)
    expect(u1.h).toBeCloseTo(0.04445)
    const u42 = deviceYM(r, dev(42))
    expect(u42.y).toBeCloseTo(RACK_BASE_M + 41 * 0.04445)
  })

  it("multi-U device occupies position upward (ascending)", () => {
    // A 4U server at position 10 spans U10–13; bottom = slot 9.
    const { y, h } = deviceYM(rack(), dev(10, 4))
    expect(y).toBeCloseTo(RACK_BASE_M + 9 * 0.04445)
    expect(h).toBeCloseTo(4 * 0.04445)
  })

  it("desc_units: position numbers from the top, physically spans downward", () => {
    // 42U rack, desc numbering: U1 is the TOP slot. A 2U device at position 1
    // occupies the two topmost slots → bottom slot index 40.
    const r = rack({ desc_units: true })
    const { y } = deviceYM(r, dev(1, 2))
    expect(y).toBeCloseTo(RACK_BASE_M + 40 * 0.04445)
    // …and at position 41 it fills the bottom two slots.
    const low = deviceYM(r, dev(41, 2))
    expect(low.y).toBeCloseTo(RACK_BASE_M)
  })

  it("starting_unit offsets the numbering, not the geometry", () => {
    const r = rack({ starting_unit: 10 })
    expect(deviceYM(r, dev(10)).y).toBeCloseTo(RACK_BASE_M)
  })
})

describe("0U appliances — non-rack-format gear renders as a shelf box, not a plane", () => {
  it("sits on its slot's bottom with a visible sub-1U height", () => {
    const { y, h } = deviceYM(rack(), dev(5, 0))
    expect(y).toBeCloseTo(RACK_BASE_M + 4 * 0.04445)
    expect(h).toBeCloseTo(APPLIANCE_H_U * 0.04445)
    expect(h).toBeGreaterThan(0)
  })

  it("desc_units: occupies the same slot a 1U device at that position would", () => {
    const r = rack({ desc_units: true })
    expect(deviceYM(r, dev(5, 0)).y).toBeCloseTo(deviceYM(r, dev(5, 1)).y)
  })

  it("boxes to appliance fractions, centred, flush with the front plane", () => {
    const b = deviceBoxM(rack(), dev(5, 0), 0.6, 1.0)
    expect(b.dw).toBeCloseTo(0.6 * APPLIANCE_W_FRAC)
    expect(b.dd).toBeCloseTo(1.0 * APPLIANCE_D_FRAC)
    expect(b.dx).toBe(0)
    // Front face on the rack's front plane (−0.45 × depth), like other gear.
    expect(b.dz - b.dd / 2).toBeCloseTo(-0.45)
  })

  it("regression: 1U+ geometry is untouched by the appliance path", () => {
    const b = deviceBoxM(rack(), dev(10, 2), 0.6, 1.0)
    expect(b.dw).toBeCloseTo(0.6 * 0.92)
    expect(b.dd).toBeCloseTo(0.9)
    expect(b.h).toBeCloseTo(2 * 0.04445)
  })
})

describe("rackFootprintM", () => {
  it("derives width from the rail opening + frame when not recorded", () => {
    const { width, depth } = rackFootprintM(rack())
    expect(width).toBeCloseTo(0.6) // 450 + 150 mm
    expect(depth).toBeCloseTo(1.0)
  })
  it("uses recorded outer dimensions when present", () => {
    const { width, depth } = rackFootprintM(
      rack({ outer_width_mm: 800, outer_depth_mm: 1200 })
    )
    expect(width).toBeCloseTo(0.8)
    expect(depth).toBeCloseTo(1.2)
  })
})

describe("trayElevationM", () => {
  const tray = (over: Partial<SceneTray>): SceneTray => ({
    id: "t",
    name: "T",
    kind: "",
    color: "",
    level: "overhead",
    elevation_mm: null,
    points: [],
    cable_count: 0,
    ...over,
  })
  it("derives from level when elevation is blank", () => {
    expect(trayElevationM(plan, tray({ level: "overhead" }))).toBeCloseTo(2.7)
    expect(trayElevationM(plan, tray({ level: "underfloor" }))).toBeCloseTo(
      -0.3
    )
    expect(trayElevationM(plan, tray({ level: "floor" }))).toBe(0)
  })
  it("an explicit elevation always wins", () => {
    expect(
      trayElevationM(plan, tray({ level: "overhead", elevation_mm: 2400 }))
    ).toBeCloseTo(2.4)
  })
})

describe("airflowGlyphPlacements", () => {
  const box = () => deviceBoxM(rack(), dev(10, 2), 0.6, 1.0)

  it("draws nothing for passive, unknown or blank airflow", () => {
    expect(airflowGlyphPlacements("passive", box())).toEqual([])
    expect(airflowGlyphPlacements("", box())).toEqual([])
    expect(airflowGlyphPlacements(undefined, box())).toEqual([])
    expect(airflowGlyphPlacements("bottom-to-top", box())).toEqual([])
  })

  it("front-to-rear: intake on the front plane, exhaust on the rear, both +Z", () => {
    const b = box()
    const g = airflowGlyphPlacements("front-to-rear", b)
    const intake = g.filter((x) => x.kind === "intake")
    const exhaust = g.filter((x) => x.kind === "exhaust")
    expect(intake.length).toBeGreaterThan(0)
    expect(intake.length).toBe(exhaust.length)
    for (const i of intake) {
      expect(i.dir).toEqual([0, 0, 1])
      expect(i.pos[2]).toBeLessThan(b.dz - b.dd / 2) // off the front plane
    }
    for (const e of exhaust) {
      expect(e.dir).toEqual([0, 0, 1])
      expect(e.pos[2]).toBeGreaterThan(b.dz + b.dd / 2)
    }
  })

  it("rear-to-front mirrors the direction and the faces", () => {
    const b = box()
    const g = airflowGlyphPlacements("rear-to-front", b)
    for (const x of g) expect(x.dir).toEqual([0, 0, -1])
    const intake = g.filter((x) => x.kind === "intake")
    for (const i of intake) expect(i.pos[2]).toBeGreaterThan(b.dz + b.dd / 2)
  })

  it("side flows run along ±X on the side planes", () => {
    const b = box()
    const lr = airflowGlyphPlacements("left-to-right", b)
    for (const x of lr) expect(x.dir).toEqual([1, 0, 0])
    const rl = airflowGlyphPlacements("right-to-left", b)
    for (const x of rl) expect(x.dir).toEqual([-1, 0, 0])
    const inL = lr.filter((x) => x.kind === "intake")
    for (const i of inL) expect(i.pos[0]).toBeLessThan(b.dx - b.dw / 2)
  })

  it("mixed draws exactly one intake + one exhaust on the exposed face", () => {
    const g = airflowGlyphPlacements("mixed", box())
    expect(g.map((x) => x.kind).sort()).toEqual(["exhaust", "intake"])
  })

  it("glyphs sit at the device's vertical centre", () => {
    const b = box()
    for (const x of airflowGlyphPlacements("front-to-rear", b))
      expect(x.pos[1]).toBeCloseTo(b.y + b.h / 2)
  })
})

describe("underfloorMM + area-aware trayElevationM", () => {
  const tray = (over: Partial<SceneTray>): SceneTray => ({
    id: "t",
    name: "T",
    kind: "",
    color: "",
    level: "overhead",
    elevation_mm: null,
    points: [],
    cable_count: 0,
    ...over,
  })
  const area = (
    x: number,
    y: number,
    w: number,
    h: number,
    plenum: number
  ) => ({
    id: `a${x}`,
    x,
    y,
    w,
    h,
    plenum_mm: plenum,
    label: "",
    color: "",
  })

  it("falls back to 300 outside every area (the historical constant)", () => {
    expect(underfloorMM(undefined, [[1, 1]])).toBe(300)
    expect(underfloorMM([area(10, 10, 4, 4, 600)], [[1, 1]])).toBe(300)
  })

  it("takes the deepest plenum a run crosses", () => {
    const areas = [area(0, 0, 10, 10, 400), area(10, 0, 10, 10, 700)]
    expect(
      underfloorMM(areas, [
        [2, 2],
        [8, 2],
      ])
    ).toBe(400)
    expect(
      underfloorMM(areas, [
        [8, 2],
        [12, 2],
      ])
    ).toBe(700)
  })

  it("trayElevationM derives −plenum for underfloor runs in an area", () => {
    const areas = [area(0, 0, 20, 16, 600)]
    const t = tray({
      level: "underfloor",
      points: [
        [2, 2],
        [6, 2],
      ],
    })
    expect(trayElevationM(plan, t, areas)).toBeCloseTo(-0.6)
    // Back-compat: omitted areas keep the historical −0.3.
    expect(trayElevationM(plan, t)).toBeCloseTo(-0.3)
    // Explicit elevation still always wins.
    expect(
      trayElevationM(
        plan,
        tray({ level: "underfloor", elevation_mm: -450 }),
        areas
      )
    ).toBeCloseTo(-0.45)
  })
})

describe("wallSegmentsWithOpenings — the geometry that shapes every room", () => {
  const H = 3 // wall height (m) for these cases
  const run: [number, number][] = [
    [0, 0],
    [10, 0],
  ]

  it("no openings → one full-height box per segment", () => {
    const L: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 6],
    ]
    const boxes = wallSegmentsWithOpenings(L, [], H)
    expect(boxes).toHaveLength(2)
    for (const b of boxes) {
      expect(b.y0).toBe(0)
      expect(b.y1).toBe(H)
    }
    expect([boxes[1].x0, boxes[1].z0, boxes[1].x1, boxes[1].z1]).toEqual([
      10, 0, 10, 6,
    ])
  })

  it("a mid-segment door yields two solid spans + a lintel over the gap", () => {
    const boxes = wallSegmentsWithOpenings(
      run,
      [{ seg: 0, from: 4, to: 5.5, height_mm: null }],
      H
    )
    expect(boxes).toHaveLength(3)
    const [lead, lintel, tail] = boxes
    expect([lead.x0, lead.x1, lead.y0, lead.y1]).toEqual([0, 4, 0, H])
    // Default door: lintel from 2.1 m up to the wall top, spanning the gap.
    expect([lintel.x0, lintel.x1]).toEqual([4, 5.5])
    expect(lintel.y0).toBeCloseTo(DOOR_DEFAULT_MM / 1000)
    expect(lintel.y1).toBe(H)
    expect([tail.x0, tail.x1]).toEqual([5.5, 10])
  })

  it("an opening at the very start produces no zero-length leading span", () => {
    const boxes = wallSegmentsWithOpenings(
      run,
      [{ seg: 0, from: 0, to: 1, height_mm: null }],
      H
    )
    // Lintel + the rest of the run — nothing degenerate before the door.
    expect(boxes).toHaveLength(2)
    expect(boxes[0].y0).toBeCloseTo(2.1)
    expect([boxes[1].x0, boxes[1].x1, boxes[1].y0]).toEqual([1, 10, 0])
  })

  it("a full-height opening drops the lintel entirely", () => {
    const boxes = wallSegmentsWithOpenings(
      run,
      [{ seg: 0, from: 4, to: 6, height_mm: 3000 }],
      H
    )
    expect(boxes).toHaveLength(2)
    for (const b of boxes) expect(b.y0).toBe(0)
  })

  it("two openings on one segment slice it into alternating spans", () => {
    const boxes = wallSegmentsWithOpenings(
      run,
      [
        { seg: 0, from: 6, to: 7, height_mm: null },
        { seg: 0, from: 2, to: 3, height_mm: 1000 },
      ],
      H
    )
    // 0–2 solid, lintel 2–3, 3–6 solid, lintel 6–7, 7–10 solid (sorted).
    const solids = boxes.filter((b) => b.y0 === 0)
    const lintels = boxes.filter((b) => b.y0 > 0)
    expect(solids.map((b) => [b.x0, b.x1])).toEqual([
      [0, 2],
      [3, 6],
      [7, 10],
    ])
    expect(lintels).toHaveLength(2)
  })

  it("an opening only affects its own segment", () => {
    const L: [number, number][] = [
      [0, 0],
      [5, 0],
      [5, 5],
    ]
    const boxes = wallSegmentsWithOpenings(
      L,
      [{ seg: 1, from: 1, to: 2, height_mm: null }],
      H
    )
    // Segment 0 stays one solid box; segment 1 splits around its door.
    const seg0 = boxes.filter((b) => b.z0 === 0 && b.z1 === 0)
    expect(seg0).toHaveLength(1)
    expect(seg0[0].y0).toBe(0)
  })

  it("out-of-range spans are clamped and inverted ones dropped", () => {
    const boxes = wallSegmentsWithOpenings(
      run,
      [
        { seg: 0, from: 8, to: 99, height_mm: null }, // clamps to 10
        { seg: 0, from: 5, to: 4, height_mm: null }, // inverted → ignored
      ],
      H
    )
    const solids = boxes.filter((b) => b.y0 === 0)
    expect(solids.map((b) => [b.x0, b.x1])).toEqual([[0, 8]])
  })
})

describe("rackViewpoint — one math for double-click fly-to and the rear flip", () => {
  // 2×2-cell rack tile centred at cell (5, 5) → world (3, 3) with 600 mm cells.
  const tile = {
    id: "t",
    x: 4,
    y: 4,
    w: 2,
    h: 2,
    orientation: 0,
    status: "",
    label: "",
    kind: "rack" as const,
    color: "",
    is_zone: false,
    rack: null,
  }

  it("frames the front out along −Z at orientation 0, the rear at +Z", () => {
    const front = rackViewpoint(plan, tile, 2, "front")
    expect(front.target).toEqual([3, 1.1, 3])
    expect(front.position[0]).toBeCloseTo(3)
    expect(front.position[2]).toBeCloseTo(3 - 2.6) // height 2 × 1.3
    const rear = rackViewpoint(plan, tile, 2, "rear")
    expect(rear.position[2]).toBeCloseTo(3 + 2.6)
    // Rear is the front mirrored through the rack centre plane.
    expect(rear.position[0]).toBeCloseTo(2 * 3 - front.position[0])
  })

  it("rotates with the tile's orientation", () => {
    const t90 = { ...tile, orientation: 90 }
    const { position } = rackViewpoint(plan, t90, 2, "front")
    // Facing east: the front viewpoint backs off along +X.
    expect(position[0]).toBeCloseTo(3 + 2.6)
    expect(position[2]).toBeCloseTo(3)
  })

  it("never gets closer than the 2.2 m comfort floor on short racks", () => {
    const { position, target } = rackViewpoint(plan, tile, 1, "front")
    expect(
      Math.hypot(position[0] - target[0], position[2] - target[2])
    ).toBeCloseTo(2.2)
  })
})

describe("sideStripBoxM — vertical 0U strips hang on the rail", () => {
  const pdu = (over = {}) =>
    dev(1, 0, { position: null, mount: "side_right", ...over })

  it("defaults to ~¾ of the rack, sitting on the base plate", () => {
    const b = sideStripBoxM(rack(), pdu(), 0.6, 1.0)
    expect(b.h).toBeCloseTo(Math.round(42 * 0.75) * 0.04445)
    expect(b.y).toBeCloseTo(RACK_BASE_M)
    expect(b.x).toBeGreaterThan(0.3) // right rail, outside the panel
    expect(b.z).toBeCloseTo(0.2) // rear half of the depth
  })

  it("left rail mirrors to −x", () => {
    const b = sideStripBoxM(rack(), pdu({ mount: "side_left" }), 0.6, 1.0)
    expect(b.x).toBeLessThan(-0.3)
  })

  it("honours span + offset, but never pokes past the rack top", () => {
    const b = sideStripBoxM(
      rack(),
      pdu({ mount_span_u: 20, mount_offset_mm: 200 }),
      0.6,
      1.0
    )
    expect(b.h).toBeCloseTo(20 * 0.04445)
    expect(b.y).toBeCloseTo(RACK_BASE_M + 0.2)
    const clamped = sideStripBoxM(
      rack(),
      pdu({ mount_span_u: 40, mount_offset_mm: 1500 }),
      0.6,
      1.0
    )
    const rackTop = RACK_BASE_M + 42 * 0.04445
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(rackTop + 1e-9)
  })
})

describe("filletPath — no installer bends a cable at 90°", () => {
  it("keeps endpoints exactly and passes collinear vertices through", () => {
    const straight: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]
    expect(filletPath(straight, 0.1)).toEqual(straight)
    const two: [number, number, number][] = [
      [0, 0, 0],
      [3, 1, 2],
    ]
    expect(filletPath(two)).toEqual(two)
  })

  it("rounds an L-corner: the hard vertex disappears, samples hug it", () => {
    const L: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
    ]
    const out = filletPath(L, 0.1, 4)
    expect(out[0]).toEqual([0, 0, 0])
    expect(out[out.length - 1]).toEqual([1, 0, 1])
    // The exact corner is gone…
    expect(out.some((p) => p[0] === 1 && p[2] === 0)).toBe(false)
    // …and every bend sample stays within the fillet's reach of it.
    for (const p of out.slice(1, -1)) {
      const d = Math.hypot(p[0] - 1, p[1], p[2])
      expect(d).toBeLessThanOrEqual(0.1 + 1e-9)
    }
  })

  it("clamps the fillet on short segments instead of overshooting", () => {
    const tight: [number, number, number][] = [
      [0, 0, 0],
      [0.05, 0, 0],
      [0.05, 0, 0.05],
    ]
    const out = filletPath(tight, 0.5, 2)
    // Pull-back is half the shortest leg (0.025) — start stays first.
    expect(out[0]).toEqual([0, 0, 0])
    expect(out[1][0]).toBeCloseTo(0.025)
  })
})

describe("offsetPolyline — tray lanes stay parallel", () => {
  it("offsets a straight run along its normal", () => {
    const out = offsetPolyline(
      [
        [0, 0],
        [4, 0],
      ],
      0.5
    )
    expect(out[0][1]).toBeCloseTo(0.5)
    expect(out[1][1]).toBeCloseTo(0.5)
    expect(out[0][0]).toBeCloseTo(0)
  })

  it("averages normals at a joint so the corner stays tight", () => {
    const out = offsetPolyline(
      [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
      0.1
    )
    // Joint normal is the 45° average of (0,1) and (-1,0).
    expect(out[1][0]).toBeCloseTo(2 - 0.1 / Math.SQRT2)
    expect(out[1][1]).toBeCloseTo(0.1 / Math.SQRT2)
  })

  it("zero offset and short inputs pass through", () => {
    expect(offsetPolyline([[1, 1]], 0.3)).toEqual([[1, 1]])
    expect(
      offsetPolyline(
        [
          [0, 0],
          [1, 0],
        ],
        0
      )
    ).toEqual([
      [0, 0],
      [1, 0],
    ])
  })
})

describe("cableLane + cableRadiusM", () => {
  it("is deterministic and bounded to the tray width", () => {
    const a = cableLane("cable-aaaa")
    expect(cableLane("cable-aaaa")).toEqual(a)
    const half = ((CABLE_LANES - 1) / 2) * CABLE_LANE_SPACING_M
    for (const id of ["x", "y", "z", "cable-1", "cable-2", "0f3a"]) {
      const { across, lift } = cableLane(id)
      expect(Math.abs(across)).toBeLessThanOrEqual(half + 1e-9)
      expect(lift).toBeGreaterThanOrEqual(0)
      expect(lift).toBeLessThan(0.05)
    }
  })

  it("spreads different ids over different lanes", () => {
    const lanes = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => cableLane(id).across)
    )
    expect(lanes.size).toBeGreaterThan(2)
  })

  it("sizes the jacket by kind: power > copper > fibre", () => {
    expect(cableRadiusM("power")).toBeGreaterThan(cableRadiusM("cat6"))
    expect(cableRadiusM("cat6")).toBeGreaterThan(cableRadiusM("smf-os2"))
    expect(cableRadiusM(null)).toBe(cableRadiusM("cat6"))
  })
})

describe("wallDoorSpans — 2D gaps from the same clamp rules", () => {
  it("interpolates the door span along its segment", () => {
    const spans = wallDoorSpans(
      [
        [0, 0],
        [0, 8],
      ],
      [{ seg: 0, from: 2, to: 3, height_mm: null }]
    )
    expect(spans).toHaveLength(1)
    expect([spans[0].x0, spans[0].z0, spans[0].x1, spans[0].z1]).toEqual([
      0, 2, 0, 3,
    ])
  })

  it("drops invalid spans exactly like the 3D span builder", () => {
    const spans = wallDoorSpans(
      [
        [0, 0],
        [4, 0],
      ],
      [
        { seg: 0, from: 3, to: 2, height_mm: null }, // inverted
        { seg: 7, from: 0, to: 1, height_mm: null }, // no such segment
      ]
    )
    expect(spans).toEqual([])
  })
})
