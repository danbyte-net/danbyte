import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { fittedModel } from "./device-model"
import { isPlacedDevice } from "./floor-device-mesh"
import {
  RAISED_FLOOR_TOP_M,
  floorDeviceBoxM,
  floorTopM,
  modelRotation,
  modelScale,
  modelTargetM,
} from "./world"
import type { ScenePayload, SceneFloorDevice, SceneTile } from "./world"

const dev = (over: Partial<SceneFloorDevice> = {}): SceneFloorDevice =>
  ({
    id: "d",
    name: "sw1",
    u_height: 1,
    rack_width: "full",
    is_full_depth: true,
    width_mm: null,
    height_mm: null,
    depth_mm: null,
    model: null,
    ...over,
  }) as SceneFloorDevice

const tile = (over: Partial<SceneTile> = {}): SceneTile =>
  ({
    id: "t",
    x: 2,
    y: 2,
    w: 1,
    h: 1,
    orientation: 0,
    kind: "device",
    is_zone: false,
    rack: null,
    ...over,
  }) as SceneTile

describe("floor-placed rack-unit devices", () => {
  it("is the rack box: 19 inch, U high, rack depth", () => {
    const b = floorDeviceBoxM(dev({ u_height: 2 }))!
    expect(b.w).toBeCloseTo(0.4826)
    expect(b.h).toBeCloseTo(0.0889)
    expect(b.d).toBeCloseTo(0.9)
    expect(floorDeviceBoxM(dev({ is_full_depth: false }))!.d).toBeCloseTo(0.45)
    expect(floorDeviceBoxM(dev({ rack_width: "half" }))!.w).toBeCloseTo(0.2413)
  })

  it("takes the type's width and depth", () => {
    const b = floorDeviceBoxM(dev({ width_mm: 440, depth_mm: 300 }))!
    expect(b.w).toBeCloseTo(0.44)
    expect(b.d).toBeCloseTo(0.3)
  })

  it("leaves 0U gear flat unless it has a model", () => {
    expect(floorDeviceBoxM(dev({ u_height: 0 }))).toBeNull()
    expect(isPlacedDevice(tile({ device: dev({ u_height: 0 }) }))).toBe(false)
    expect(
      isPlacedDevice(
        tile({
          device: dev({
            u_height: 0,
            model: {
              url: "/m",
              source: "type",
              fit: "auto",
              up: "y",
              front: "+z",
            },
          }),
        })
      )
    ).toBe(true)
    expect(isPlacedDevice(tile({ device: dev() }))).toBe(true)
    expect(isPlacedDevice(tile())).toBe(false)
  })

  it("stands a measured device as its own w × h × d box, 0U or not", () => {
    const sized = { width_mm: 600, height_mm: 1800, depth_mm: 400 }
    for (const u_height of [0, 2]) {
      const b = floorDeviceBoxM(dev({ u_height, ...sized }))!
      expect([b.w, b.h, b.d]).toEqual([0.6, 1.8, 0.4])
    }
    expect(
      isPlacedDevice(tile({ device: dev({ u_height: 0, ...sized }) }))
    ).toBe(true)
    // A 0U device missing one axis stays flat.
    expect(
      floorDeviceBoxM(dev({ u_height: 0, width_mm: 600, depth_mm: 400 }))
    ).toBeNull()
  })

  it("fits a model to the measured size it is sent", () => {
    // The scene sends the device's own size, else its type's.
    expect(
      modelTargetM(dev({ width_mm: 600, height_mm: 1800, depth_mm: 400 }), {
        w: 1.2,
        d: 1.2,
      })
    ).toEqual({ w: 0.6, h: 1.8, d: 0.4 })
  })

  it("stands on a raised floor's top", () => {
    const scene = {
      plan: { cell_mm: 600 },
      raised_floors: [{ id: "r", x: 0, y: 0, w: 5, h: 5, plenum_mm: 300 }],
    } as unknown as ScenePayload
    expect(floorTopM(scene, tile())).toBe(RAISED_FLOOR_TOP_M)
    expect(floorTopM(scene, tile({ x: 9 }))).toBe(0)
  })
})

describe("model placement", () => {
  it("turns the named front to the tile's front (-Z)", () => {
    const front = (f: "+z" | "-z" | "+x" | "-x") => {
      const [rx, ry, rz] = modelRotation("y", f)
      const axis = {
        "+z": [0, 0, 1],
        "-z": [0, 0, -1],
        "+x": [1, 0, 0],
        "-x": [-1, 0, 0],
      }[f]
      return new THREE.Vector3(
        ...(axis as [number, number, number])
      ).applyEuler(new THREE.Euler(rx, ry, rz, "YXZ"))
    }
    for (const f of ["+z", "-z", "+x", "-x"] as const) {
      const v = front(f)
      expect(v.z).toBeCloseTo(-1)
      expect(Math.abs(v.x)).toBeLessThan(1e-9)
    }
  })

  it("stands a Z-up model upright", () => {
    const [rx, ry, rz] = modelRotation("z", "-z")
    const up = new THREE.Vector3(0, 0, 1).applyEuler(
      new THREE.Euler(rx, ry, rz, "YXZ")
    )
    expect(up.y).toBeCloseTo(1)
  })

  it("fits uniformly inside the known size, or keeps its own", () => {
    expect(modelScale([2, 1, 4], { w: 0.5, h: 1, d: 1 }, "auto")).toBeCloseTo(
      0.25
    )
    expect(modelScale([2, 1, 4], { h: 0.5 }, "auto")).toBeCloseTo(0.5)
    expect(modelScale([2, 1, 4], { w: 0.5 }, "native")).toBe(1)
    expect(modelScale([2, 1, 4], null, "auto")).toBe(1)
    expect(modelTargetM(dev({ u_height: 0 }))).toBeNull()
    expect(modelTargetM(dev({ u_height: 0, height_mm: 200 }))).toEqual({
      w: undefined,
      h: 0.2,
      d: undefined,
    })
  })

  it("fills the tile when the type has no measured size", () => {
    // A 1U printer type with no width/height/depth: the rack-unit box would
    // squeeze the model to 44 mm tall; the tile's footprint sets it instead.
    const target = modelTargetM(dev({ u_height: 1 }), { w: 0.6, d: 0.6 })
    expect(target).toEqual({ w: 0.6, d: 0.6 })
    // A 30-unit model fills 0.6 m across, not 44 mm high.
    expect(modelScale([30, 30, 26], target, "auto")).toBeCloseTo(0.02)
    expect(
      modelTargetM(dev({ u_height: 1, height_mm: 400 }), { w: 0.6, d: 0.6 })
    ).toEqual({ w: undefined, h: 0.4, d: undefined })
  })

  it("stands the fitted model on the floor, centred", () => {
    // A Z-up model 1000 x 500 x 200 (mm-ish units), offset from the origin.
    const box = new THREE.Box3(
      new THREE.Vector3(10, 20, 0),
      new THREE.Vector3(1010, 520, 200)
    )
    const fit = fittedModel(
      box,
      { fit: "auto", up: "z", front: "-z" },
      { w: 0.5 }
    )
    expect(fit.scale).toBeCloseTo(0.0005)
    expect(fit.size[0]).toBeCloseTo(0.5)
    expect(fit.size[1]).toBeCloseTo(0.1) // its Z became height
    const g = new THREE.Group()
    g.position.set(...fit.position)
    g.scale.setScalar(fit.scale)
    const inner = new THREE.Group()
    inner.rotation.copy(fit.rotation)
    g.add(inner)
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1000, 500, 200).translate(510, 270, 100)
    )
    inner.add(m)
    g.updateMatrixWorld(true)
    const placed = new THREE.Box3().setFromObject(g)
    expect(placed.min.y).toBeCloseTo(0)
    expect((placed.min.x + placed.max.x) / 2).toBeCloseTo(0)
    expect((placed.min.z + placed.max.z) / 2).toBeCloseTo(0)
  })
})
