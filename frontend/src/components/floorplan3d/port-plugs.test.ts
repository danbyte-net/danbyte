import { describe, expect, it } from "vitest"
import * as THREE from "three"

import type { ModelBay } from "@/lib/api"

import { assembleModel } from "./model-assembly"
import { anchorMatrices, partMeshes } from "./port-plugs"

function named(name: string, at: [number, number, number] = [0, 0, 0]) {
  const o = new THREE.Object3D()
  o.userData.gltfName = name
  o.position.set(...at)
  return o
}

/** A chassis with a front port turned to face −Z (the anchor's +Z out of
 * the port) and a module bay; the module carries a `{module}` port. */
function assembled() {
  const chassis = new THREE.Group()
  const port = named("port:Gi1/0/1", [0.1, 0.02, -0.2])
  port.rotation.y = Math.PI
  chassis.add(port)
  chassis.add(named("bay:NM", [0, 0.03, 0.2]))
  const nm = new THREE.Group()
  nm.add(named("port:Te1/{module}/1", [0.01, 0, 0]))
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

  it("seats a part's meshes and recolours only CABLE and FIBRE", () => {
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
    const meshes = partMeshes(part)
    expect(meshes.map((m) => m.recolour)).toEqual([false, true])
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
