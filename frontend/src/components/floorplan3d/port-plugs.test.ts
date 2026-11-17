import { describe, expect, it } from "vitest"
import * as THREE from "three"

import type { ModelBay } from "@/lib/api"

import { assembleModel } from "./model-assembly"
import type { PortPlug } from "@/lib/port-plugs"

import {
  anchorMatrices,
  cableEmptyMatrix,
  cordEndOf,
  partMeshes,
  receptacleMatrix,
  seatParts,
} from "./port-plugs"

function named(name: string, at: [number, number, number] = [0, 0, 0]) {
  const o = new THREE.Object3D()
  o.userData.gltfName = name
  o.position.set(...at)
  return o
}

/** A `port:` or `cable` empty as Blender's glTF exporter writes it: the
 * part frame it stands for (`turn`, +Z out, +Y up) with the exporter's
 * +90° about X on top, so its arrow is its local +Y. */
const EXPORTED = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI / 2
)
function empty(
  name: string,
  at: [number, number, number] = [0, 0, 0],
  turn = new THREE.Euler()
) {
  const o = named(name, at)
  o.quaternion.setFromEuler(turn).multiply(EXPORTED)
  return o
}

/** A chassis with a front port turned to face −Z (the anchor's +Z out of
 * the port) and a module bay; the module carries a `{module}` port. */
function assembled() {
  const chassis = new THREE.Group()
  chassis.add(
    empty("port:Gi1/0/1", [0.1, 0.02, -0.2], new THREE.Euler(0, Math.PI, 0))
  )
  chassis.add(named("bay:NM", [0, 0.03, 0.2]))
  const nm = new THREE.Group()
  nm.add(empty("port:Te1/{module}/1", [0.01, 0, 0]))
  const bays: ModelBay[] = [
    { name: "NM", position: "1", installed: true, part: null },
  ]
  return assembleModel(chassis, [{ bay: "NM", position: "1", scene: nm }], bays)
    .root
}

const at = (m: THREE.Matrix4 | null) => {
  const p = new THREE.Vector3().setFromMatrixPosition(m!)
  return [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000)
}

describe("plugs on a placed model", () => {
  it("finds each plug's anchor, chassis and module, in the root's frame", () => {
    const root = assembled()
    const m = anchorMatrices(root, [
      { port: "Gi1/0/1", bay: null },
      { port: "Te1/1/1", bay: "NM" },
      // The chassis has no such port; a module port is not the chassis'.
      { port: "Gi1/0/9", bay: null },
      { port: "Te1/1/1", bay: null },
    ])
    expect(at(m[0])).toEqual([0.1, 0.02, -0.2])
    expect(at(m[1])).toEqual([0.01, 0.03, 0.2])
    expect(m[2]).toBeNull()
    expect(m[3]).toBeNull()
    // The part's +Z (out along the cable) follows the anchor's: out of the
    // front, toward −Z.
    const out = new THREE.Vector3(0, 0, 1).transformDirection(m[0]!)
    expect(out.z).toBeCloseTo(-1)
  })

  it("seats a part's meshes and recolours only CABLE, FIBRE and LC_BODY", () => {
    const metal = new THREE.MeshStandardMaterial({ name: "Metal" })
    const cable = new THREE.MeshStandardMaterial({
      name: "CABLE",
      color: "#cccccc",
    })
    const part = new THREE.Group()
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.02), metal)
    body.position.z = -0.01
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.02), cable)
    boot.position.z = 0.01
    part.add(body, boot)
    const lc = new THREE.Mesh(
      new THREE.BoxGeometry(0.01, 0.01, 0.01),
      new THREE.MeshStandardMaterial({ name: "LC_BODY" })
    )
    const fibre = new THREE.Mesh(
      new THREE.BoxGeometry(0.01, 0.01, 0.01),
      new THREE.MeshStandardMaterial({ name: "FIBRE" })
    )
    part.add(lc, fibre)
    const meshes = partMeshes(part)
    expect(meshes.map((m) => m.recolour)).toEqual([false, true, true, true])
    expect(meshes.map((m) => m.channel)).toEqual([null, "cable", "lc", "fibre"])
    expect(meshes[0].material).toBe(metal)
    const white = meshes[1].material as THREE.MeshStandardMaterial
    expect(white).not.toBe(cable)
    expect(white.color.getHexString()).toBe("ffffff")
    expect(cable.color.getHexString()).toBe("cccccc")
    // One clone per source material, however often the part is seated.
    expect(partMeshes(part)[1].material).toBe(white)
    expect(
      new THREE.Vector3().setFromMatrixPosition(meshes[1].local).z
    ).toBeCloseTo(0.01)
  })
})

// ── stacking ────────────────────────────────────────────────────────────────

const SFP_URL = "/api/accessory-types/sfp/model/?v=1"
const LC_URL = "/api/accessory-types/lc/model/?v=1"

const stacked = (over: Partial<PortPlug> = {}): PortPlug => ({
  port: "Gi1/0/1",
  bay: null,
  name: "Gi1/0/1",
  color: null,
  cable_type: "smf-os2",
  cabled: true,
  transceiver_part: { url: SFP_URL, kind: "transceiver", connector: "lc" },
  cord_part: { url: LC_URL, kind: "plug", connector: "lc", cable: null },
  ...over,
})

/** A transceiver whose `port:lc` receptacle sits 12 mm out and 1 mm up,
 * turned a quarter about its +Z (an odd pose, so the composition shows). */
function transceiver(name = "port:lc") {
  const t = new THREE.Group()
  t.add(empty(name, [0, 0.001, 0.012], new THREE.Euler(0, 0, Math.PI / 2)))
  return t
}

/** A cord whose `cable` empty ends its stub 40 mm out. */
function cord() {
  const c = new THREE.Group()
  c.add(empty("cable", [0, 0, 0.04]))
  return c
}

describe("stacking a cord on its transceiver", () => {
  it("seats the cord at anchor × receptacle, the transceiver at the anchor", () => {
    const root = assembled()
    const plugs = [stacked()]
    const anchors = anchorMatrices(root, plugs)
    const t = transceiver()
    const seats = seatParts(plugs, anchors, (u) => (u === SFP_URL ? t : cord()))
    expect(seats.map((s) => s.role)).toEqual(["transceiver", "cord"])
    expect(at(seats[0].matrix)).toEqual([0.1, 0.02, -0.2])
    // The anchor faces −Z (a half turn about Y): 12 mm out is toward −Z,
    // 1 mm up stays up.
    expect(at(seats[1].matrix)).toEqual([0.1, 0.021, -0.212])
    const x = new THREE.Vector3(1, 0, 0).transformDirection(seats[1].matrix)
    // The receptacle's quarter turn about +Z carries through: its +X is the
    // anchor's +Y.
    expect([x.x, x.y, x.z].map((v) => Math.round(v) + 0)).toEqual([0, 1, 0])
    expect(seats[1].colours.lc).not.toBe(seats[1].colours.fibre)
  })

  it("takes the one port: empty, else the anchor, and waits while loading", () => {
    const root = assembled()
    const plugs = [stacked()]
    const anchors = anchorMatrices(root, plugs)
    const single = seatParts(plugs, anchors, (u) =>
      u === SFP_URL ? transceiver("port:receptacle") : cord()
    )
    expect(at(single[1].matrix)).toEqual([0.1, 0.021, -0.212])
    const bare = seatParts(plugs, anchors, (u) =>
      u === SFP_URL ? new THREE.Group() : cord()
    )
    expect(at(bare[1].matrix)).toEqual([0.1, 0.02, -0.2])
    const failed = seatParts(plugs, anchors, (u) =>
      u === SFP_URL ? null : cord()
    )
    expect(failed.map((s) => s.role)).toEqual(["transceiver", "cord"])
    const loading = seatParts(plugs, anchors, () => undefined)
    expect(loading.map((s) => s.role)).toEqual(["transceiver"])
  })

  it("puts a cord alone at the anchor, and nothing where the model lacks it", () => {
    const root = assembled()
    const plugs = [
      stacked({ transceiver_part: null }),
      stacked({ port: "Gi1/0/9", name: "Gi1/0/9" }),
    ]
    const seats = seatParts(plugs, anchorMatrices(root, plugs), () => cord())
    expect(seats).toHaveLength(1)
    expect([seats[0].role, at(seats[0].matrix)]).toEqual([
      "cord",
      [0.1, 0.02, -0.2],
    ])
  })

  it("finds the receptacle by the cord's connector before the transceiver's", () => {
    const t = new THREE.Group()
    t.add(empty("port:lc", [0, 0, 0.01]), empty("port:mpo", [0, 0, 0.02]))
    expect(at(receptacleMatrix(t, ["mpo", "lc"]))).toEqual([0, 0, 0.02])
    expect(at(receptacleMatrix(t, ["lc"]))).toEqual([0, 0, 0.01])
    expect(receptacleMatrix(t, ["rj45"])).toBeNull()
  })

  it("publishes the cable empty in the room's frame", () => {
    const root = assembled()
    const plugs = [stacked()]
    const seats = seatParts(plugs, anchorMatrices(root, plugs), (u) =>
      u === SFP_URL ? transceiver() : cord()
    )
    const world = new THREE.Matrix4().makeTranslation(1, 0, 0)
    const end = cordEndOf(
      world,
      seats[1].matrix,
      cableEmptyMatrix(cord())!,
      null
    )
    expect(end.at.map((v) => Math.round(v * 1000) / 1000)).toEqual([
      1.1, 0.021, -0.252,
    ])
    // Along the cable: out of the front, toward −Z.
    expect(end.z[2]).toBeCloseTo(-1)
    expect(end.scale).toBeCloseTo(1)
  })
})
