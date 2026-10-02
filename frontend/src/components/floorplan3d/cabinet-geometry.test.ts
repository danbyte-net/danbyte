import { describe, expect, it } from "vitest"

import type { Device, DinRail } from "@/lib/api"
import { deviceBody } from "@/lib/din-geometry"
import { cabinetPhotoBox } from "@/lib/photo-calibration"

import {
  CABINET_DOOR_M,
  CABINET_WALL_M,
  DEVICE_DEPTH_FALLBACK_MM,
  DOOR_OPEN_RAD,
  DOOR_SWING_S,
  PLATE_STANDOFF_M,
  PLATE_T_M,
  RAIL_DEPTH_MM,
  deviceBoxM,
  doorAngle,
  doorHingeM,
  doorStep,
  offsetOnBodyM,
  photoFace,
  placeDevices,
  plateBoxM,
  plateFrameM,
  platePointM,
  railBoxM,
  shellWallsM,
  swingPoint,
} from "./cabinet-geometry"
import type { Box3M } from "./cabinet-geometry"

// A DIN-rail cabinet opened up in 3D: the plate, rails and devices placed
// from the same millimetres the 2D plate draws, the open box's walls, and
// the door's swing. "Test cabinet" on dev: a 500×600 plate in a
// 550×650×200 box, rails R1 and R2.

const box = { width: 0.55, height: 0.65, depth: 0.2 }
const plate = { width_mm: 500, height_mm: 600 }
const frame = plateFrameM(box, plate)

const rail = (patch: Partial<DinRail> = {}): DinRail => ({
  id: "r1",
  label: "R1",
  profile: "ts35",
  x_mm: 0,
  y_mm: 150,
  length_mm: 500,
  ...patch,
})

const device = (patch: Partial<Device> = {}): Device =>
  ({
    id: "d1",
    name: "kbh-ind-sw-02",
    din_rail: { id: "r1", label: "R1", profile: "ts35" },
    din_offset_mm: 140,
    device_type: {
      id: "t-xc206",
      name: "SCALANCE XC206-2SFP G",
      width_mm: 60,
      height_mm: 147,
      din_rail_mm: null,
      din_profiles: ["ts35"],
      front_image: "/media/xc206.png",
      front_cal: null,
    },
    image_ports: null,
    role: null,
    ...patch,
  }) as unknown as Device

const lo = (b: Box3M, k: 0 | 1 | 2) => b.center[k] - b.size[k] / 2
const hi = (b: Box3M, k: 0 | 1 | 2) => b.center[k] + b.size[k] / 2

describe("plateFrameM", () => {
  it("centres the plate across the front, as the 2D drawing does", () => {
    // Facing the front your left is +x: the plate's left edge is there.
    expect(frame.left).toBeCloseTo(0.25)
    expect(frame.width).toBeCloseTo(0.5)
    expect(frame.top).toBeCloseTo(0.625)
    expect(frame.top - frame.height).toBeCloseTo(0.025)
  })

  it("stands the plate on stand-offs in front of the back wall", () => {
    const p = plateBoxM(frame)
    expect(hi(p, 2)).toBeCloseTo(
      box.depth / 2 - CABINET_WALL_M - PLATE_STANDOFF_M
    )
    expect(lo(p, 2)).toBeCloseTo(frame.front)
    expect(p.size[2]).toBeCloseTo(PLATE_T_M)
    expect(p.center[0]).toBeCloseTo(0)
  })
})

describe("platePointM", () => {
  it("reads plate millimetres from the top-left corner as you face it", () => {
    expect(platePointM(frame, 0, 0)).toEqual([frame.left, frame.top])
    const [x, y] = platePointM(frame, 100, 50)
    // Right on the plate is −x; down is −y.
    expect(x).toBeCloseTo(frame.left - 0.1)
    expect(y).toBeCloseTo(frame.top - 0.05)
  })
})

describe("railBoxM", () => {
  it("is a bar its profile's band high, standing proud of the plate", () => {
    const bar = railBoxM(frame, rail())
    expect(bar.size[0]).toBeCloseTo(0.5)
    expect(bar.size[1]).toBeCloseTo(0.035)
    expect(bar.size[2]).toBeCloseTo(RAIL_DEPTH_MM.ts35 / 1000)
    // Centred on its centreline, its back on the plate's face.
    expect(bar.center[1]).toBeCloseTo(frame.top - 0.15)
    expect(hi(bar, 2)).toBeCloseTo(frame.front)
  })

  it("runs from its left end along the plate", () => {
    const bar = railBoxM(frame, rail({ x_mm: 100, length_mm: 200 }))
    expect(hi(bar, 0)).toBeCloseTo(frame.left - 0.1)
    expect(lo(bar, 0)).toBeCloseTo(frame.left - 0.3)
  })

  it("takes each profile's own band and depth", () => {
    const ts15 = railBoxM(frame, rail({ profile: "ts15" }))
    const g32 = railBoxM(frame, rail({ profile: "g32" }))
    expect(ts15.size[1]).toBeCloseTo(0.015)
    expect(ts15.size[2]).toBeCloseTo(0.0055)
    expect(g32.size[1]).toBeCloseTo(0.032)
    expect(g32.size[2]).toBeCloseTo(0.015)
  })
})

describe("deviceBoxM", () => {
  const r = rail()
  const body = deviceBody(r, 140, {
    width_mm: 60,
    height_mm: 147,
    din_rail_mm: null,
  })!

  it("stands where the 2D plate draws the body, its back on the rail", () => {
    const b = deviceBoxM(frame, body, "ts35", 125)
    expect(b.size[0]).toBeCloseTo(0.06)
    expect(b.size[1]).toBeCloseTo(0.147)
    expect(b.size[2]).toBeCloseTo(0.125)
    // Left edge 140 mm along the rail, its middle on the centreline.
    expect(hi(b, 0)).toBeCloseTo(frame.left - 0.14)
    expect(b.center[1]).toBeCloseTo(frame.top - 0.15)
    expect(hi(b, 2)).toBeCloseTo(frame.front - RAIL_DEPTH_MM.ts35 / 1000)
  })

  it("fits inside the box with the door shut", () => {
    const b = deviceBoxM(frame, body, "ts35", 125)
    expect(lo(b, 2)).toBeGreaterThan(-box.depth / 2 + CABINET_DOOR_M)
  })

  it("falls back to a depth when the type records none", () => {
    expect(deviceBoxM(frame, body, "ts35", null).size[2]).toBeCloseTo(
      DEVICE_DEPTH_FALLBACK_MM / 1000
    )
    expect(deviceBoxM(frame, body, "ts35", 0).size[2]).toBeCloseTo(
      DEVICE_DEPTH_FALLBACK_MM / 1000
    )
  })
})

describe("placeDevices", () => {
  const rails = [rail(), rail({ id: "r2", label: "R2", y_mm: 400 })]

  it("places each device on its rail with its type's depth", () => {
    const placed = placeDevices(frame, rails, [device()], (id) =>
      id === "t-xc206" ? 125 : null
    )
    expect(placed).toHaveLength(1)
    expect(placed[0].rail.id).toBe("r1")
    expect(placed[0].body).toEqual({ x: 140, y: 76.5, width: 60, height: 147 })
    expect(placed[0].box.size[2]).toBeCloseTo(0.125)
  })

  it("leaves out what the 2D plate leaves out", () => {
    const off = device({ id: "off", din_rail: null, din_offset_mm: null })
    const gone = device({
      id: "gone",
      din_rail: { id: "nope", label: "X", profile: "ts35" },
    })
    const sizeless = device({
      id: "sizeless",
      device_type: { ...device().device_type!, width_mm: null },
    })
    const placed = placeDevices(frame, rails, [off, gone, sizeless], () => 1)
    expect(placed).toEqual([])
  })
})

describe("photoFace", () => {
  const body = { x: 140, y: 76.5, width: 60, height: 147 }

  it("covers the whole face with a photo stretched over the body", () => {
    expect(photoFace(body, body)).toEqual({
      rect: body,
      uv: [0, 0, 1, 1],
    })
  })

  it("clips a calibrated photo to the body, as the 2D plate does", () => {
    // A photo 60 mm wide whose rail line sits at its middle: true height
    // 60 × aspect; taller than the body here, so its top and bottom go.
    const photo = cabinetPhotoBox(
      body,
      { left: 0, rail: 0.5, photo_mm: 60 },
      3,
      150
    )
    expect(photo).toEqual({ x: 140, y: 60, width: 60, height: 180 })
    const face = photoFace(body, photo)!
    expect(face.rect).toEqual(body)
    const [u0, v0, u1, v1] = face.uv
    expect(u0).toBeCloseTo(0)
    expect(u1).toBeCloseTo(1)
    // The body runs from 16.5 mm below the photo's top to 16.5 above its
    // foot: both ends of the photo go.
    expect(v1).toBeCloseTo(1 - 16.5 / 180)
    expect(v0).toBeCloseTo(16.5 / 180)
  })

  it("draws only the part of the face a smaller photo covers", () => {
    const photo = { x: 150, y: 100, width: 20, height: 40 }
    const face = photoFace(body, photo)!
    expect(face.rect).toEqual(photo)
    expect(face.uv).toEqual([0, 0, 1, 1])
    // Its middle 10 mm left of the body's middle (+x) and 30 mm above it.
    const [x, y] = offsetOnBodyM(body, face.rect)
    expect(x).toBeCloseTo(0.01)
    expect(y).toBeCloseTo(0.03)
  })

  it("is nothing where photo and body do not meet", () => {
    expect(photoFace(body, { x: 0, y: 0, width: 10, height: 10 })).toBeNull()
    expect(photoFace(body, { ...body, width: 0 })).toBeNull()
  })
})

describe("the open box", () => {
  const walls = shellWallsM(box)

  it("is five walls behind the door's depth, inside the outer box", () => {
    expect(walls).toHaveLength(5)
    for (const w of walls) {
      expect(lo(w, 0)).toBeGreaterThanOrEqual(-box.width / 2 - 1e-9)
      expect(hi(w, 0)).toBeLessThanOrEqual(box.width / 2 + 1e-9)
      expect(lo(w, 1)).toBeGreaterThanOrEqual(-1e-9)
      expect(hi(w, 1)).toBeLessThanOrEqual(box.height + 1e-9)
      expect(lo(w, 2)).toBeGreaterThanOrEqual(
        -box.depth / 2 + CABINET_DOOR_M - 1e-9
      )
      expect(hi(w, 2)).toBeLessThanOrEqual(box.depth / 2 + 1e-9)
    }
  })

  it("has no two walls overlapping, so no face is drawn twice", () => {
    const overlap = (a: Box3M, b: Box3M) =>
      ([0, 1, 2] as const).every(
        (k) => lo(a, k) < hi(b, k) - 1e-9 && lo(b, k) < hi(a, k) - 1e-9
      )
    for (let i = 0; i < walls.length; i++)
      for (let j = i + 1; j < walls.length; j++)
        expect(overlap(walls[i], walls[j])).toBe(false)
  })

  it("closes with the door into the whole box again", () => {
    // Volume of the walls plus the slab the shut door fills, against the
    // box's shell: the outer box less its hollow.
    const vol = (b: Box3M) => b.size[0] * b.size[1] * b.size[2]
    const t = CABINET_WALL_M
    const behind = box.depth - CABINET_DOOR_M
    const hollow = (box.width - 2 * t) * (box.height - 2 * t) * (behind - t)
    const shell =
      box.width * box.height * behind -
      hollow +
      box.width * box.height * CABINET_DOOR_M
    const drawn =
      walls.reduce((s, w) => s + vol(w), 0) +
      box.width * box.height * CABINET_DOOR_M
    expect(drawn).toBeCloseTo(shell, 9)
  })
})

describe("the door", () => {
  it("hangs from its left edge as you face it, on the front plane", () => {
    expect(doorHingeM(box)).toEqual([0.275, -0.1])
  })

  it("swings open in DOOR_SWING_S and shut again", () => {
    let p = 0
    for (let i = 0; i < 60 * DOOR_SWING_S; i++) p = doorStep(p, true, 1 / 60)
    expect(p).toBeCloseTo(1)
    expect(doorStep(1, true, 1 / 60)).toBe(1)
    expect(doorStep(0.01, false, 1)).toBe(0)
    expect(doorStep(0.5, true, 1, 0)).toBe(1)
  })

  it("eases from shut to 110 degrees open", () => {
    expect(doorAngle(0)).toBeCloseTo(0)
    expect(doorAngle(1)).toBeCloseTo(-DOOR_OPEN_RAD)
    expect(doorAngle(0.5)).toBeCloseTo(-DOOR_OPEN_RAD / 2)
    // Slow out of the frame, fastest through the middle.
    expect(Math.abs(doorAngle(0.1))).toBeLessThan(DOOR_OPEN_RAD * 0.1)
    expect(doorAngle(2)).toBeCloseTo(-DOOR_OPEN_RAD)
  })

  it("swings its free edge out toward you, past the hinge side", () => {
    // The free edge sits a door's width from the hinge, toward −x.
    const [x, z] = swingPoint(-box.width, 0, doorAngle(1))
    expect(z).toBeLessThan(-box.width * 0.9)
    expect(x).toBeGreaterThan(0)
    // Half-way it is already out in front of the box.
    expect(swingPoint(-box.width, 0, doorAngle(0.5))[1]).toBeLessThan(0)
  })
})
