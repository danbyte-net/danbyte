import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { EAR_PLATE_MM, rackMountOf } from "@/lib/rack-mount"
import type { RackMountBlock, RackMountInfo } from "@/lib/rack-mount"

import { fittedModel } from "./device-model"
import type { ModelEntry } from "./device-model"
import { anchorMatrices } from "./port-plugs"
import {
  instancedParts,
  placeInstances,
  sharedAssembly,
  slotMatrix,
} from "./rack-model-draw"
import type { RackModelDraw } from "./rack-model-draw"
import { LEGACY_LOOK, railPlanesM } from "./rack-kit-math"
import type { SceneLook } from "./rack-kit-math"
import { rackSlotPose, rackSlotTargetM } from "./rack-models"
import { deviceBoxM, portLocalM, rackRailPlanesM } from "./world"
import type { SceneDevice, SceneModel, SceneRack } from "./world"

/**
 * Racked gear on its rails (lib/rack-mount, world `rackRailPlanesM`): the
 * box and the model stand on the rack's rail plane, out by the ears'
 * offset, turned round on the rear rail; the instanced model and every
 * anchor its overlays take from the shared copy follow the shifted slot.
 */

const BLOCK: RackMountBlock = {
  ears: true,
  positions: { front: 0, mid: 220, rear: 430 },
  default: "front",
  rails: "none",
}

const rack = (look?: Partial<SceneLook>): SceneRack =>
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
    ...(look ? { look: { ...LEGACY_LOOK, ...look } } : {}),
  }) satisfies SceneRack

const MODEL: SceneModel = {
  url: "/sw.glb",
  source: "type",
  fit: "auto",
  up: "y",
  front: "-z",
}

const dev = (
  mount: RackMountInfo | undefined,
  over: Partial<SceneDevice> = {}
): SceneDevice =>
  ({
    id: "d",
    name: "sw1",
    position: 10,
    face: "front",
    rack_side: "",
    u_height: 1,
    rack_width: "full",
    is_full_depth: false,
    rack_mount: mount,
    model: MODEL,
    ...over,
  }) as SceneDevice

/** The box's front plane (the faceplate) and the model's (its fitted
 * box's most forward point), z in the rack frame. */
const boxFront = (r: SceneRack, d: SceneDevice) => {
  const b = deviceBoxM(r, d, 0.6, 1)
  return b.mountedRear ? b.dz + b.dd / 2 : b.dz - b.dd / 2
}
const SIZE = [0.4826, 0.044, 0.4] as const
const modelFront = (r: SceneRack, d: SceneDevice) => {
  const p = rackSlotPose(r, d, 1, SIZE)
  return d.face === "rear"
    ? p.position[2] + SIZE[2] / 2
    : p.position[2] - SIZE[2] / 2
}

describe("rail planes", () => {
  it("keeps the legacy cabinet's rails without a Look", () => {
    expect(rackRailPlanesM(1, undefined)).toEqual({ front: -0.45, rear: 0.45 })
    expect(railPlanesM(1, LEGACY_LOOK)).toEqual(rackRailPlanesM(1, null))
  })
})

/** Eared gear stands out by its ears' plate, whose back is on the rail. */
const P = EAR_PLATE_MM / 1000

describe("ear position", () => {
  it("leaves front-fitted and unrecorded gear where it stood", () => {
    for (const m of [undefined, rackMountOf(null), rackMountOf(BLOCK)]) {
      expect(boxFront(rack(), dev(m))).toBeCloseTo(-0.45 - P, 9)
      expect(modelFront(rack(), dev(m))).toBeCloseTo(-0.45 - P, 9)
    }
  })

  it("moves the faceplate out by each position's offset", () => {
    const mid = dev(rackMountOf(BLOCK, "mid"))
    const rear = dev(rackMountOf(BLOCK, "rear"))
    expect(boxFront(rack(), mid)).toBeCloseTo(-0.45 - 0.22 - P, 9)
    expect(modelFront(rack(), mid)).toBeCloseTo(-0.45 - 0.22 - P, 9)
    expect(boxFront(rack(), rear)).toBeCloseTo(-0.45 - 0.43 - P, 9)
    expect(modelFront(rack(), rear)).toBeCloseTo(-0.45 - 0.43 - P, 9)
  })

  it("stands a recessed fitting's model on its ears, the box on its faceplate", () => {
    const recessed = { ...BLOCK, positions: { front: -40, rear: 300 } }
    // Front: the ears on the rail, the faceplate 40 mm behind them.
    const f = dev(rackMountOf(recessed))
    expect(modelFront(rack(), f)).toBeCloseTo(-0.45 - P, 9)
    expect(boxFront(rack(), f)).toBeCloseTo(-0.41 - P, 9)
    // Rear fitting: the faceplate 300 mm out, the model's ears 40 mm more.
    const r = dev(rackMountOf(recessed, "rear"))
    expect(boxFront(rack(), r)).toBeCloseTo(-0.75 - P, 9)
    expect(modelFront(rack(), r)).toBeCloseTo(-0.79 - P, 9)
  })

  it("puts an earless device's faceplate on the front rail", () => {
    const earless = rackMountOf({
      ears: false,
      positions: {},
      default: "",
      rails: "sliding",
    })
    expect(boxFront(rack(), dev(earless))).toBeCloseTo(-0.45, 9)
    expect(modelFront(rack(), dev(earless))).toBeCloseTo(-0.45, 9)
  })

  it("shifts rear-mounted gear toward the rear, on the rear rail", () => {
    const d = dev(rackMountOf(BLOCK, "mid"), { face: "rear" })
    expect(boxFront(rack(), d)).toBeCloseTo(0.45 + 0.22 + P, 9)
    expect(modelFront(rack(), d)).toBeCloseTo(0.45 + 0.22 + P, 9)
    expect(rackSlotPose(rack(), d, 1, SIZE).rotY).toBeCloseTo(Math.PI, 9)
    // The rear rail of a rail depth: 740 mm behind the front one.
    const r = rack({ frame: "4-post", rail_depth_mm: 740 })
    expect(boxFront(r, d)).toBeCloseTo(-0.45 + 0.74 + 0.22 + P, 9)
  })

  it("mounts 2-post gear on the one mid-depth rail", () => {
    const r = rack({ frame: "2-post" })
    const front = dev(rackMountOf(BLOCK, "mid"))
    expect(boxFront(r, front)).toBeCloseTo(-0.22 - P, 9)
    expect(modelFront(r, front)).toBeCloseTo(-0.22 - P, 9)
    const back = dev(rackMountOf(BLOCK), { face: "rear" })
    expect(boxFront(r, back)).toBeCloseTo(P, 9)
    expect(modelFront(r, back)).toBeCloseTo(P, 9)
  })

  it("moves the box's port markers with it", () => {
    const flush = deviceBoxM(rack(), dev(undefined), 0.6, 1)
    const mid = deviceBoxM(rack(), dev(rackMountOf(BLOCK, "mid")), 0.6, 1)
    const at = { x: 0.3, y: 0.5 }
    const a = portLocalM(flush, at)
    const b = portLocalM(mid, at)
    expect(b[2] - a[2]).toBeCloseTo(-0.22, 9)
    expect(b[0]).toBeCloseTo(a[0], 9)
    expect(b[1]).toBeCloseTo(a[1], 9)
  })
})

// ── the instanced path ──────────────────────────────────────────────────────

function switchScene(): THREE.Group {
  const root = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.044, 0.4),
    new THREE.MeshStandardMaterial({ color: "#2a2a2a" })
  )
  body.userData.gltfName = "body"
  root.add(body)
  const port = new THREE.Object3D()
  port.userData.gltfName = "port:Gi1/0/1"
  port.position.set(-0.1, 0.02, -0.2)
  root.add(port)
  root.updateMatrixWorld(true)
  return root
}

describe("instanced models on the rails", () => {
  const scene = switchScene()
  const entry: ModelEntry = {
    status: "ready",
    scene,
    triangles: 0,
    box: new THREE.Box3().setFromObject(scene),
    anchors: { bays: [], empties: [] },
  }
  const r = rack()
  const mounts = [
    rackMountOf(BLOCK),
    rackMountOf(BLOCK, "mid"),
    rackMountOf(BLOCK, "rear"),
  ]
  const draws: RackModelDraw[] = mounts.map((m, i) => {
    const d = dev(m, { id: `d${i}`, position: 1 + i })
    const fit = fittedModel(entry.box!, MODEL, rackSlotTargetM(r, d))
    return {
      level: "full",
      entry,
      parts: [],
      fit,
      pose: rackSlotPose(r, d, 1, fit.size),
      bays: null,
      emptyMode: "filler",
      groupKey: "/sw.glb|full|mount",
    }
  })
  const ids = draws.map((_, i) => `d${i}`)
  const shared = sharedAssembly(draws[0])
  const parts = instancedParts(shared.meshes, draws.length, true)
  placeInstances(parts, null, draws, ids, {})

  it("draws each instance out by its own ear offset", () => {
    const body = parts.find((p) => p.part.mesh.userData.gltfName === "body")!
    const z = draws.map((_, i) => {
      const m = new THREE.Matrix4()
      body.im.getMatrixAt(i, m)
      return new THREE.Vector3().setFromMatrixPosition(m).z
    })
    expect(z[1] - z[0]).toBeCloseTo(-0.22, 5)
    expect(z[2] - z[0]).toBeCloseTo(-0.43, 5)
  })

  it("puts each member's anchors where its shifted slot puts the port", () => {
    const [anchor] = anchorMatrices(shared.root, [
      { port: "Gi1/0/1", bay: null },
    ])
    const at = draws.map((d) =>
      new THREE.Vector3().setFromMatrixPosition(
        new THREE.Matrix4().multiplyMatrices(
          slotMatrix(d.pose, d.fit),
          new THREE.Matrix4().multiplyMatrices(shared.root.matrix, anchor!)
        )
      )
    )
    // The port sits 0.2 m behind the model's front (its box's −Z face).
    expect(at[0].z).toBeCloseTo(-0.45 - P, 5)
    expect(at[1].z).toBeCloseTo(-0.67 - P, 5)
    expect(at[2].z).toBeCloseTo(-0.88 - P, 5)
  })
})
