import { describe, expect, it } from "vitest"
import * as THREE from "three"

import type { ModelBay } from "@/lib/api"

import { assembleModel } from "./model-assembly"
import { applyPortCovers, findPortCovers } from "./port-covers"

function named(name: string, child?: THREE.Object3D) {
  const o = new THREE.Object3D()
  o.userData.gltfName = name
  if (child) o.add(child)
  return o
}

function mesh() {
  return new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01))
}

/** A stack switch with two stack blanks (one -kn style, its mesh on a
 * child) and a network module bay; the module has a {module} dust plug. */
function scenes() {
  const chassis = new THREE.Group()
  chassis.add(named("cover:port:StackPort1/1", mesh()))
  const plug = mesh()
  plug.userData.gltfName = "cover:port:StackPort1/2"
  chassis.add(plug)
  chassis.add(named("bay:NM"))
  const nm = new THREE.Group()
  nm.add(named("cover:port:Te1/{module}/1", mesh()))
  return { chassis, nm }
}

function assembled() {
  const { chassis, nm } = scenes()
  const bays: ModelBay[] = [
    { name: "NM", position: "1", installed: true, part: null },
  ]
  return assembleModel(chassis, [{ bay: "NM", position: "1", scene: nm }], bays)
    .root
}

describe("port covers on a placed model", () => {
  it("finds chassis and module covers with their bay", () => {
    const found = findPortCovers(assembled())
    expect(found.map((c) => [c.name, c.bay, c.meshes.length]).sort()).toEqual([
      ["StackPort1/1", null, 1],
      ["StackPort1/2", null, 1],
      ["Te1/1/1", "NM", 1],
    ])
  })

  it("hides cabled ports' covers and shows them again", () => {
    const root = assembled()
    const bound = findPortCovers(root)
    const vis = () =>
      Object.fromEntries(
        bound.map((c) => [`${c.bay ?? ""}:${c.name}`, c.node.visible])
      )
    expect(
      applyPortCovers(bound, {
        covers: ["StackPort1/1"],
        bay_covers: { NM: ["Te1/1/1"] },
      })
    ).toBe(true)
    expect(vis()).toEqual({
      ":StackPort1/1": false,
      ":StackPort1/2": true,
      "NM:Te1/1/1": false,
    })
    // The same answer again changes nothing.
    expect(
      applyPortCovers(bound, {
        covers: ["StackPort1/1"],
        bay_covers: { NM: ["Te1/1/1"] },
      })
    ).toBe(false)
    // Uncabled, or no payload: as authored.
    expect(applyPortCovers(bound, { covers: [] })).toBe(true)
    expect(Object.values(vis()).every(Boolean)).toBe(true)
    applyPortCovers(bound, { covers: ["StackPort1/2"] })
    applyPortCovers(bound, null)
    expect(Object.values(vis()).every(Boolean)).toBe(true)
  })

  it("leaves the shared scene alone", () => {
    const { chassis } = scenes()
    const root = assembleModel(chassis, [], null).root
    applyPortCovers(findPortCovers(root), { covers: ["StackPort1/1"] })
    expect(findPortCovers(chassis).every((c) => c.node.visible)).toBe(true)
  })
})
