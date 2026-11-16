import * as THREE from "three"

import { coverHidden, portCoverName } from "@/lib/port-covers"
import type { DeviceCovers } from "@/lib/port-covers"

/**
 * Port covers on an assembled model (docs/dcim/model-packs.md → Port
 * covers): each `cover:port:<interface>` node of a placed copy, shown while
 * its port is free and hidden once the device's payload names it (lib/
 * port-covers). Hiding the named node hides its meshes with it - gltfpack
 * `-kn` keeps the mesh on a child. Far copies drawn instanced
 * (rack-model-draw) hide a cover per instance instead, from `meshes`.
 */

/** A cover of a placed copy: its name as drawn, the bay its module sits in
 * (the nearest part root model-assembly tagged `danbyteBay`; null for the
 * chassis'), its node and the meshes under it. */
export interface BoundCover {
  name: string
  bay: string | null
  node: THREE.Object3D
  meshes: THREE.Mesh[]
}

export function findPortCovers(root: THREE.Object3D): BoundCover[] {
  const out: BoundCover[] = []
  root.traverse((o) => {
    const name = portCoverName(o.userData.gltfName)
    if (name === null) return
    let bay: string | null = null
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
      if (typeof p.userData.danbyteBay === "string") {
        bay = p.userData.danbyteBay
        break
      }
    }
    const meshes: THREE.Mesh[] = []
    o.traverse((c) => {
      if (c instanceof THREE.Mesh) meshes.push(c)
    })
    out.push({ name, bay, node: o, meshes })
  })
  return out
}

/** Show or hide each cover for `dev` (null or undefined: all shown, as
 * authored). Returns whether anything changed. */
export function applyPortCovers(
  bound: readonly BoundCover[],
  dev: DeviceCovers | null | undefined
): boolean {
  let changed = false
  for (const c of bound) {
    const visible = !coverHidden(dev, c.name, c.bay)
    if (c.node.visible !== visible) {
      c.node.visible = visible
      changed = true
    }
  }
  return changed
}
