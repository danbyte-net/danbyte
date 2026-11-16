import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { LED_MAX_DEVICES, ledRequestIds } from "@/lib/use-device-leds"

import { fittedModel } from "./device-model"
import { slotMatrix } from "./rack-model-draw"
import {
  RACK_FAR_IN_M,
  RACK_FAR_OUT_M,
  RACK_FULL_IN_M,
  RACK_FULL_OUT_M,
  allocateModels,
  createModelBudget,
  instanceGroupKey,
  parseLevels,
  rackFrameWidthM,
  rackSlotPose,
  rackSlotTargetM,
  rackToWorld,
  wantedRackLevel,
} from "./rack-models"
import type { ModelWant, RackModelLevel } from "./rack-models"
import { deviceBoxM } from "./world"
import type { SceneDevice, SceneModel, SceneRack } from "./world"

const rack = (over: Partial<SceneRack> = {}): SceneRack =>
  ({
    id: "r",
    name: "R1",
    u_height: 42,
    starting_unit: 1,
    desc_units: false,
    width: 19,
    outer_width_mm: 600,
    outer_depth_mm: 1000,
    devices: [],
    ...over,
  }) satisfies SceneRack

const dev = (over: Partial<SceneDevice> = {}): SceneDevice =>
  ({
    id: "d",
    name: "sw1",
    position: 10,
    face: "front",
    rack_side: "",
    u_height: 1,
    rack_width: "full",
    is_full_depth: true,
    ...over,
  }) as SceneDevice

const MODEL: SceneModel = {
  url: "/m.glb",
  source: "type",
  fit: "auto",
  up: "y",
  front: "+z",
}

/** A C9500 as authored: 482.6 × 44 × 458.5 mm, front on +Z. */
const c9500 = (unit = 1) =>
  new THREE.Box3(
    new THREE.Vector3(-0.2413 * unit, 0, -0.22925 * unit),
    new THREE.Vector3(0.2413 * unit, 0.044 * unit, 0.22925 * unit)
  )

describe("rack slot fit", () => {
  it("fits a 19-inch model to the frame and its units", () => {
    expect(rackFrameWidthM(rack())).toBeCloseTo(0.4826, 6)
    const t = rackSlotTargetM(rack(), dev())
    expect(t.w).toBeCloseTo(0.4826, 6)
    expect(t.h).toBeCloseTo(0.04445, 6)
    // Authored in metres: stays its size. In millimetres: scaled down.
    for (const unit of [1, 1000]) {
      const fit = fittedModel(c9500(unit), MODEL, t)
      expect(fit.size[0]).toBeCloseTo(0.4826, 4)
      expect(fit.size[1]).toBeCloseTo(0.044, 4)
      expect(fit.size[2]).toBeCloseTo(0.4585, 4)
    }
  })

  it("gives half-width gear half the frame and wider racks their ears", () => {
    expect(rackSlotTargetM(rack(), dev({ rack_width: "half" })).w).toBeCloseTo(
      0.2413,
      6
    )
    expect(rackFrameWidthM(rack({ width: 23 }))).toBeCloseTo(0.5836, 6)
    // A 2U device is two units tall.
    expect(rackSlotTargetM(rack(), dev({ u_height: 2 })).h).toBeCloseTo(
      0.0889,
      6
    )
  })
})

describe("rack slot pose", () => {
  const size = [0.4826, 0.044, 0.4585] as const

  it("puts a front-mounted model's front on the front rail", () => {
    const r = rack()
    const d = dev()
    const pose = rackSlotPose(r, d, 1, size)
    expect(pose.rotY).toBe(0)
    // Its front (−Z, d/2 ahead of its origin) on the rail plane - where the
    // photo box's face is.
    const box = deviceBoxM(r, d, 0.6, 1)
    expect(pose.position[2] - size[2] / 2).toBeCloseTo(box.dz - box.dd / 2, 6)
    // Standing in its slot, centred in the unit's spare height.
    expect(pose.position[1]).toBeCloseTo(box.y + (0.04445 - 0.044) / 2, 6)
    expect(pose.position[0]).toBe(0)
  })

  it("turns a rear-mounted model round, its front on the rear rail", () => {
    const r = rack()
    const d = dev({ face: "rear" })
    const pose = rackSlotPose(r, d, 1, size)
    expect(pose.rotY).toBeCloseTo(Math.PI, 9)
    // Turned half round, its front sits at +d/2 from its origin.
    expect(pose.position[2] + size[2] / 2).toBeCloseTo(0.45, 6)
  })

  it("puts half-width gear on its side", () => {
    const r = rack()
    const left = rackSlotPose(
      r,
      dev({ rack_width: "half", rack_side: "left" }),
      1,
      size
    )
    const right = rackSlotPose(
      r,
      dev({ rack_width: "half", rack_side: "right" }),
      1,
      size
    )
    expect(left.position[0]).toBeCloseTo(-0.1125, 6)
    expect(right.position[0]).toBeCloseTo(0.1125, 6)
  })

  it("counts units top-down in a descending rack", () => {
    const asc = rackSlotPose(rack(), dev({ position: 1 }), 1, size)
    const desc = rackSlotPose(
      rack({ desc_units: true }),
      dev({ position: 1 }),
      1,
      size
    )
    expect(desc.position[1]).toBeGreaterThan(asc.position[1] + 1.5)
  })

  it("follows the rack's own turn in the room", () => {
    const local: [number, number, number] = [0.1, 1, -0.3]
    // Unturned: just moved to the tile's centre.
    expect(rackToWorld([5, 7], 0, local)).toEqual([5.1, 1, 6.7])
    // Turned a quarter: three's rotation about Y, as the rack group turns.
    const q = rackToWorld([5, 7], Math.PI / 2, local)
    const v = new THREE.Vector3(...local).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2
    )
    expect(q[0]).toBeCloseTo(5 + v.x, 9)
    expect(q[2]).toBeCloseTo(7 + v.z, 9)
    // The front rail faces where the rack faces: a front-mounted model's
    // front lands on the rack's front, wherever it is turned.
    for (const rotY of [0, Math.PI / 2, Math.PI, -0.7]) {
      const pose = rackSlotPose(rack(), dev(), 1, size)
      const front = rackToWorld([0, 0], rotY, [
        pose.position[0],
        0,
        pose.position[2] - size[2] / 2,
      ])
      // The rack's world front normal is (−sin, 0, −cos).
      const along = front[0] * -Math.sin(rotY) + front[2] * -Math.cos(rotY)
      expect(along).toBeCloseTo(0.45, 6)
    }
  })

  it("composes slot and fit into one matrix", () => {
    const fit = fittedModel(c9500(1000), MODEL, rackSlotTargetM(rack(), dev()))
    const pose = rackSlotPose(rack(), dev({ face: "rear" }), 1, fit.size)
    const m = slotMatrix(pose, fit)
    // The authored front centre (+Z, mm) lands on the rear rail.
    const p = new THREE.Vector3(0, 22, 229.25).applyMatrix4(m)
    expect(p.z).toBeCloseTo(0.45, 4)
    expect(p.x).toBeCloseTo(0, 6)
  })
})

describe("rack model level of detail", () => {
  it("steps full, far, box with a gap each way", () => {
    expect(wantedRackLevel(1, "box")).toBe("full")
    expect(wantedRackLevel(RACK_FULL_IN_M + 0.1, "box")).toBe("far")
    // Inside the gap, each keeps what it has.
    const gapFull = (RACK_FULL_IN_M + RACK_FULL_OUT_M) / 2
    expect(wantedRackLevel(gapFull, "full")).toBe("full")
    expect(wantedRackLevel(gapFull, "far")).toBe("far")
    const gapFar = (RACK_FAR_IN_M + RACK_FAR_OUT_M) / 2
    expect(wantedRackLevel(gapFar, "far")).toBe("far")
    expect(wantedRackLevel(gapFar, "box")).toBe("box")
    expect(wantedRackLevel(RACK_FAR_OUT_M + 0.1, "far")).toBe("box")
  })

  it("doesn't flicker when the camera wobbles on an edge", () => {
    let level: RackModelLevel = "box"
    const seen = new Set<RackModelLevel>()
    for (let i = 0; i < 50; i++) {
      level = wantedRackLevel(RACK_FAR_IN_M - 0.2 + (i % 2) * 0.4, level)
      seen.add(level)
    }
    expect([...seen]).toEqual(["far"])
  })
})

describe("triangle budget", () => {
  const want = (o: Partial<ModelWant> & { id: string }): ModelWant => ({
    dist: 1,
    level: "full",
    full: 100,
    far: 10,
    ...o,
  })

  it("gives near devices far copies, upgrades the nearest, then the rest", () => {
    const out = allocateModels(
      [
        want({ id: "c", dist: 3 }),
        want({ id: "a", dist: 1 }),
        want({ id: "b", dist: 2 }),
        want({ id: "d", dist: 4, level: "far" }),
      ],
      215,
      1000
    )
    // Three near far copies (30), a's and b's upgrades (180): 5 left, too
    // few for c's upgrade or the farther d's far copy.
    expect(out.get("a")).toBe("full")
    expect(out.get("b")).toBe("full")
    expect(out.get("c")).toBe("far")
    expect(out.get("d")).toBe("box")
    // Past the budget even for far copies, the farthest keep their box.
    const tight = allocateModels(
      [want({ id: "a", dist: 1 }), want({ id: "b", dist: 2 })],
      15,
      1000
    )
    expect(tight.get("a")).toBe("far")
    expect(tight.get("b")).toBe("box")
  })

  it("keeps room for full models when a whole rack is up close", () => {
    // Standing at a rack: 300 devices want full; their far copies alone
    // (300 × 8) would take the whole budget.
    const wants = Array.from({ length: 300 }, (_, i) =>
      want({
        id: `d${String(i).padStart(3, "0")}`,
        dist: 1 + i / 100,
        full: 180,
        far: 8,
      })
    )
    const out = allocateModels(wants, 2400, 500)
    const levels = wants.map((w) => out.get(w.id))
    // The nearest are full, the next far copies, the farthest boxes.
    expect(levels.slice(0, 6)).toEqual(Array(6).fill("full"))
    expect(levels.filter((l) => l === "full").length).toBeGreaterThanOrEqual(6)
    expect(levels.filter((l) => l === "far").length).toBeGreaterThan(100)
    expect(levels[299]).toBe("box")
  })

  it("respects the one-model limit and models not loaded yet", () => {
    const out = allocateModels(
      [
        want({ id: "big", full: 600 }),
        want({ id: "loading", full: null, far: null }),
        want({ id: "farOnly", full: null }),
      ],
      10_000,
      500
    )
    expect(out.get("big")).toBe("far")
    expect(out.get("loading")).toBe("box")
    expect(out.get("farOnly")).toBe("far")
  })

  it("is shared with the floor devices across racks", () => {
    const budget = createModelBudget(300, 1000)
    let heard = 0
    budget.subscribe(() => heard++)
    budget.setWants("r1", [want({ id: "a", dist: 1 })])
    budget.setWants("r2", [want({ id: "b", dist: 2 })])
    expect(parseLevels(budget.ownerKey("r1")).get("a")).toBe("full")
    expect(budget.levelOf("b")).toBe("full")
    expect(budget.drawnKey()).toBe("a,b")
    // The floor spends first: the farther rack device steps down.
    budget.setFloor(150)
    expect(budget.levelOf("a")).toBe("full")
    expect(budget.levelOf("b")).toBe("far")
    const before = heard
    // The same wants again change nothing and tell nobody.
    budget.setWants("r1", [want({ id: "a", dist: 1 })])
    expect(heard).toBe(before)
    budget.setWants("r1", [])
    expect(budget.ownerKey("r1")).toBe("")
    expect(budget.levelOf("b")).toBe("full")
    expect(budget.drawnKey()).toBe("b")
  })

  it("groups identical devices for instancing", () => {
    const bays = [{ name: "PS-0", installed: true }]
    const a = instanceGroupKey(
      "/far.glb",
      [{ bay: "PS-0", url: "/p" }],
      bays,
      "filler"
    )
    const b = instanceGroupKey(
      "/far.glb",
      [{ bay: "PS-0", url: "/p" }],
      bays,
      "filler"
    )
    const c = instanceGroupKey(
      "/far.glb",
      [],
      [{ name: "PS-0", installed: false }],
      "filler"
    )
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe("LED batching", () => {
  it("asks once per device, in a stable order, within the server's limit", () => {
    expect(ledRequestIds(["b", "a", "b"])).toEqual(["a", "b"])
    const many = Array.from({ length: LED_MAX_DEVICES + 20 }, (_, i) => `d${i}`)
    const ids = ledRequestIds(["floor", ...many])
    expect(ids).toHaveLength(LED_MAX_DEVICES)
    // The ones listed first (the floor's, then the nearest racks') stay.
    expect(ids).toContain("floor")
    expect(ids).not.toContain(`d${LED_MAX_DEVICES + 19}`)
  })
})
