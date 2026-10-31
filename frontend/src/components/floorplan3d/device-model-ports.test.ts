import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { normalisePoint, portFromHit, portLocal } from "@/lib/model-ports"
import type { ModelPortsDoc, V3 } from "@/lib/model-ports"

import { cableEndsAnchored, cableRunPoints } from "./cable-trace-3d"
import { fittedModel } from "./device-model"
import {
  findModelPort,
  floorModelPortLocal,
  hitNormal,
  mappedModelSizeM,
  snapToSurface,
  tileFootprintM,
  uprightOf,
} from "./device-model-ports"
import { placedToWorld, portViewpoint } from "./floor-device-mesh"
import { cellToWorld, modelTargetM } from "./world"
import type {
  SceneFloorDevice,
  SceneModel,
  ScenePayload,
  SceneTile,
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

/** A 0.4 × 0.05 × 0.3 box as authored: Y up, its front on +Z. */
function boxModel(w = 0.4, h = 0.05, d = 0.3) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial()
  )
  const g = new THREE.Group()
  g.add(mesh)
  return g
}

/** The editor's scene graph: centred, turned upright. */
function mount(u: ReturnType<typeof uprightOf>) {
  const root = new THREE.Group()
  root.position.set(...(u.center.map((v) => -v) as V3))
  const turn = new THREE.Group()
  turn.rotation.copy(u.rotation)
  turn.add(u.object)
  root.add(turn)
  root.updateMatrixWorld(true)
  return root
}

describe("raycast placement", () => {
  it("a click on the front face is a port on z = 0 facing −Z", () => {
    const u = uprightOf(boxModel(), "y", "+z")
    mount(u)
    // The room's front is −Z: shoot in from there, 0.1 m right of centre.
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0.1, 0, -1),
      new THREE.Vector3(0, 0, 1)
    )
    const hit = ray.intersectObject(u.object, true)[0]
    const normal = hitNormal(hit, ray.ray.direction)!
    const point = hit.point.clone().add(new THREE.Vector3(...u.center))
    const port = portFromHit({ point: point.toArray(), normal }, u.min, u.max)
    expect(port.p).toEqual([0.75, 0.5, 0])
    expect(port.n).toEqual([0, 0, -1])
  })

  it("drops a point inside the box onto the surface along its normal", () => {
    const u = uprightOf(boxModel(), "y", "+z")
    mount(u)
    const snapped = snapToSurface(u, {
      kind: "interface",
      name: "Gi1",
      p: [0.3, 0.5, 0.4],
      n: [0, 0, -1],
    })
    expect(snapped.p[2]).toBeCloseTo(0)
    expect(snapped.p[0]).toBeCloseTo(0.3)
  })
})

describe("normalised to world", () => {
  const cases: [SceneModel["up"], SceneModel["front"]][] = [
    ["y", "+z"],
    ["z", "+x"],
    ["z", "-z"],
    ["y", "-x"],
  ]
  for (const [up, front] of cases) {
    it(`lands on the fitted model, up ${up}, front ${front}`, () => {
      const model = boxModel(0.5, 0.2, 0.1)
      const raw = new THREE.Box3().setFromObject(model)
      const target = { w: 0.44, h: 0.1, d: 0.3 }
      const fit = fittedModel(raw, { fit: "auto", up, front }, target)
      const u = uprightOf(model, up, front)
      // A corner of the authored box, where PlacedModel puts it.
      const corner = new THREE.Vector3(0.25, 0.1, -0.05)
      const placed = corner
        .clone()
        .applyEuler(fit.rotation)
        .multiplyScalar(fit.scale)
        .add(new THREE.Vector3(...fit.position))
      const upright = corner.clone().applyEuler(u.rotation)
      const p = normalisePoint(upright.toArray(), u.min, u.max)
      const at = portLocal(p, fit.size)
      at.forEach((v, i) => expect(v).toBeCloseTo(placed.getComponent(i), 5))
      // The bounds alone give the same size before the file loads.
      const size = mappedModelSizeM(
        {
          width_mm: 440,
          height_mm: 100,
          depth_mm: 300,
          model: { url: "/m", source: "type", fit: "auto", up, front },
        },
        { bounds: u.size },
        null
      )
      size.forEach((v, i) => expect(v).toBeCloseTo(fit.size[i], 6))
    })
  }

  it("a model with no measured size fills the tile", () => {
    const t = { w: 2, h: 1, orientation: 90 }
    expect(tileFootprintM(plan, t)).toEqual({ w: 0.6, d: 1.2 })
    expect(
      modelTargetM(
        { width_mm: null, height_mm: null, depth_mm: null },
        {
          w: 0.6,
          d: 1.2,
        }
      )
    ).toEqual({ w: 0.6, d: 1.2 })
  })
})

// ─── The room: cable ends and the camera ─────────────────────────────────────

const doc: ModelPortsDoc = {
  bounds: [0.4, 0.05, 0.3],
  ports: [
    { kind: "interface", name: "Gi1/0/1", p: [0.75, 0.5, 0], n: [0, 0, -1] },
    { kind: "interface", name: "Gi1/0/2", p: [0.25, 0.5, 1], n: [0, 0, 1] },
  ],
}

const floorDev = (over: Partial<SceneFloorDevice> = {}): SceneFloorDevice =>
  ({
    id: "fd",
    name: "ap1",
    position: null,
    u_height: 0,
    rack_width: "full",
    is_full_depth: true,
    width_mm: 400,
    height_mm: 50,
    depth_mm: 300,
    image_ports: null,
    model: { url: "/m", source: "type", fit: "auto", up: "y", front: "+z" },
    model_ports: doc,
    ...over,
  }) as SceneFloorDevice

const tileOf = (device: SceneFloorDevice, over: Partial<SceneTile> = {}) =>
  ({
    id: "t1",
    x: 4,
    y: 4,
    w: 1,
    h: 1,
    orientation: 0,
    kind: "device",
    is_zone: false,
    rack: null,
    device,
    ...over,
  }) as SceneTile

const sceneOf = (tiles: SceneTile[]) =>
  ({ plan, tiles, trays: [], raised_floors: [] }) as unknown as ScenePayload

const path = (a: string, b: string) => ({
  id: "c1",
  label: "",
  color: "",
  type: "cat6",
  a_tiles: ["t1"],
  b_tiles: ["t2"],
  a_points: [{ device: "fd", port: a }],
  b_points: [{ device: "fd2", port: b }],
  tray_ids: [],
})

describe("cable ends on mapped model ports", () => {
  const a = tileOf(floorDev())
  const b = tileOf(floorDev({ id: "fd2", model_ports: null, model: null }), {
    id: "t2",
    x: 10,
  })
  const scene = sceneOf([a, b])
  const sites = new Map([
    ["fd", { tile: a, devIndex: -1, floor: true }],
    ["fd2", { tile: b, devIndex: -1, floor: true }],
  ])

  it("start at the exact port, then leave along its normal", () => {
    const pts = cableRunPoints(scene, sites, path("gi1/0/1", "eth0"))!
    const [cx, cz] = cellToWorld(plan, 4.5, 4.5)
    // Gi1/0/1: x 0.75 of 0.4 m, half way up 5 cm, on the front face.
    expect(pts[0][0]).toBeCloseTo(cx + 0.1)
    expect(pts[0][1]).toBeCloseTo(0.025)
    expect(pts[0][2]).toBeCloseTo(cz - 0.15)
    // Out of the front (−Z) before it turns up.
    expect(pts[1][2]).toBeLessThan(pts[0][2])
  })

  it("count as anchored; an unmapped port falls back", () => {
    expect(cableEndsAnchored(scene, path("Gi1/0/2", "eth0"))[0]).toBe(true)
    expect(cableEndsAnchored(scene, path("Gi9", "eth0"))[0]).toBe(false)
  })

  it("follow the tile's turn", () => {
    const turned = tileOf(floorDev(), { orientation: 90 })
    const port = findModelPort(turned.device!, "Gi1/0/1")!
    const local = floorModelPortLocal({ plan }, turned, turned.device!, port)!
    const pts = cableRunPoints(
      sceneOf([turned, b]),
      new Map([
        ["fd", { tile: turned, devIndex: -1, floor: true }],
        ["fd2", { tile: b, devIndex: -1, floor: true }],
      ]),
      path("Gi1/0/1", "eth0")
    )!
    const [cx, cz] = cellToWorld(plan, 4.5, 4.5)
    const world = placedToWorld(
      { centre: [cx, cz], floorY: 0, rotY: -Math.PI / 2 },
      local.at,
      local.normal
    )
    expect(pts[0][0]).toBeCloseTo(world.point.x)
    expect(pts[0][2]).toBeCloseTo(world.point.z)
  })

  it("double-click flies out along the port's normal", () => {
    const vp = portViewpoint(
      { centre: [1, 1], floorY: 0, rotY: 0 },
      { at: [0, 0.02, -0.15], normal: [0, 0, -1] }
    )
    expect(vp.target.toArray()).toEqual([1, 0.02, 0.85])
    expect(vp.position.z).toBeLessThan(vp.target.z)
  })
})
