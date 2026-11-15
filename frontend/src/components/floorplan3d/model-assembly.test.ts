import { describe, expect, it } from "vitest"
import * as THREE from "three"

import type { ModelBay } from "@/lib/api"

import {
  anchorNames,
  assembleModel,
  namedNodes,
  posedPoint,
} from "./model-assembly"

/** A node as the loader leaves it: three's rewritten name, the real one
 * in userData. */
function node(gltfName: string, parent?: THREE.Object3D) {
  const o = new THREE.Group()
  o.name = gltfName.replace(/[:/]/g, "").replace(/ /g, "_")
  o.userData.gltfName = gltfName
  parent?.add(o)
  return o
}

/** gltfpack -kn: the named node, its mesh on a child. */
function cover(name: string, parent: THREE.Object3D) {
  const n = node(`empty:${name}`, parent)
  n.add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.001)))
  return n
}

function chassis() {
  const root = new THREE.Group()
  const ps0 = node("bay:PS-0", root)
  ps0.position.set(0.17, 0.0015, -0.45)
  ps0.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
  const fan = node("bay:FAN 1", root)
  fan.position.set(0.1, 0.0017, -0.45)
  cover("PS-0", root)
  cover("FAN 1", root)
  cover("FAN 2", root)
  return root
}

function module() {
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.3)))
  const port = node("port:Te1/{module}/1", root)
  port.position.set(0.01, 0.02, 0)
  return root
}

const bay = (name: string, url: string | null, position = "1"): ModelBay => ({
  name,
  position,
  installed: !!url,
  part: url ? { url, far_url: null } : null,
})

describe("namedNodes", () => {
  it("finds nodes by their glTF names, not three's", () => {
    const named = namedNodes(chassis())
    expect(named.has("bay:FAN 1")).toBe(true)
    expect(named.has("bayFAN_1")).toBe(false)
    expect(anchorNames(chassis())).toEqual({
      bays: ["PS-0", "FAN 1"],
      empties: ["PS-0", "FAN 1", "FAN 2"],
    })
  })
})

describe("posing", () => {
  it("puts a module's origin on the bay, turned with it", () => {
    const c = chassis()
    const at = posedPoint(c, "PS-0", [0.01, 0.02, 0])!
    expect(at.x).toBeCloseTo(0.16)
    expect(at.y).toBeCloseTo(0.0215)
    expect(at.z).toBeCloseTo(-0.45)
    // A point toward the module's back (-Z) goes into the chassis (+Z).
    expect(posedPoint(c, "PS-0", [0, 0, -0.3])!.z).toBeCloseTo(-0.15)
    expect(posedPoint(c, "nope", [0, 0, 0])).toBeNull()
  })

  it("assembles parts at their bays with {module} resolved", () => {
    const { root, drawn } = assembleModel(
      chassis(),
      [{ bay: "PS-0", position: "0", scene: module() }],
      [bay("PS-0", "/m", "0"), bay("FAN 1", null)]
    )
    expect([...drawn]).toEqual(["PS-0"])
    root.updateMatrixWorld(true)
    const port = namedNodes(root).get("port:Te1/0/1")!
    expect(port).toBeDefined()
    const p = new THREE.Vector3().setFromMatrixPosition(port.matrixWorld)
    expect(p.x).toBeCloseTo(0.16)
    expect(p.z).toBeCloseTo(-0.45)
    // The shared module scene keeps its token for the next device.
    const again = assembleModel(
      chassis(),
      [{ bay: "PS-0", position: "1", scene: module() }],
      null
    )
    expect(namedNodes(again.root).has("port:Te1/1/1")).toBe(true)
  })

  it("leaves the source scenes alone", () => {
    const c = chassis()
    const m = module()
    assembleModel(c, [{ bay: "PS-0", position: "0", scene: m }], [])
    expect(namedNodes(c).get("bay:PS-0")!.children).toHaveLength(0)
    expect(namedNodes(m).has("port:Te1/{module}/1")).toBe(true)
  })
})

describe("covers", () => {
  const visible = (root: THREE.Object3D) =>
    Object.fromEntries(
      [...namedNodes(root)]
        .filter(([n]) => n.startsWith("empty:"))
        .map(([n, o]) => [n.slice(6), o.visible])
    )

  it("hides the cover where a part is drawn and covers the device lacks", () => {
    const { root } = assembleModel(
      chassis(),
      [{ bay: "PS-0", position: "0", scene: module() }],
      [bay("PS-0", "/m"), bay("FAN 1", null)]
    )
    expect(visible(root)).toEqual({
      "PS-0": false,
      "FAN 1": true,
      "FAN 2": false,
    })
  })

  it("draws the model as authored without bay data", () => {
    const { root } = assembleModel(chassis(), [], null)
    expect(Object.values(visible(root)).every(Boolean)).toBe(true)
  })

  it("hides every cover with empty mode nothing", () => {
    const { root } = assembleModel(
      chassis(),
      [],
      [bay("FAN 1", null)],
      "nothing"
    )
    expect(Object.values(visible(root)).some(Boolean)).toBe(false)
  })
})
