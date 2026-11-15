import * as THREE from "three"

import type { ModelBay, ModelEmptyMode } from "@/lib/api"
import {
  coverVisibility,
  parseAnchor,
  substituteModule,
} from "@/lib/model-assembly"

/**
 * A device's model put together (docs/dcim/model-packs.md): the chassis,
 * each installed module's model posed at the chassis' `bay:<name>` node,
 * and the `empty:<name>` covers shown or hidden (lib/model-assembly).
 *
 * A module file's origin is its mount point, so posing it is parenting it
 * to the bay node: the module lands at the bay's place and turn, and the
 * chassis' fit (scale, up/front turn) carries both. The `-kn` layout - a
 * named node with its mesh on a child - needs nothing special: hiding a
 * cover node hides its child mesh with it.
 */

/** A loaded scene's anchor nodes by their exact glTF name (kept in
 * `userData.gltfName` by the loader; three's `name` is rewritten). The
 * first node of a name wins. */
export function namedNodes(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const out = new Map<string, THREE.Object3D>()
  root.traverse((o) => {
    const n = o.userData.gltfName
    if (typeof n === "string" && parseAnchor(n) && !out.has(n)) out.set(n, o)
  })
  return out
}

/** The anchor names in a scene, by kind - what a loaded entry records. */
export function anchorNames(root: THREE.Object3D): {
  bays: string[]
  empties: string[]
} {
  const bays: string[] = []
  const empties: string[] = []
  for (const name of namedNodes(root).keys()) {
    const a = parseAnchor(name)!
    if (a.kind === "bay") bays.push(a.name)
    if (a.kind === "empty") empties.push(a.name)
  }
  return { bays, empties }
}

/** A module's copy as it sits in a bay: its node names with `{module}`
 * resolved to the bay's position (a port or LED there names the device's
 * real interface). */
export function placedPart(scene: THREE.Object3D, position: string) {
  const part = scene.clone(true)
  part.traverse((o) => {
    const n = o.userData.gltfName
    if (typeof n === "string" && n.includes("{module}"))
      o.userData = { ...o.userData, gltfName: substituteModule(n, position) }
  })
  return part
}

export interface AssemblyPart {
  bay: string
  position: string
  scene: THREE.Object3D
}

/**
 * The chassis copy with its parts in place and its covers set. `bays` null
 * (no assembly data) leaves every cover as authored. Returns the new root
 * and the bays a part was posed in.
 */
export function assembleModel(
  chassis: THREE.Object3D,
  parts: readonly AssemblyPart[],
  bays: readonly ModelBay[] | null | undefined,
  mode: ModelEmptyMode = "filler"
): { root: THREE.Object3D; drawn: Set<string> } {
  const root = chassis.clone(true)
  const named = namedNodes(root)
  const drawn = new Set<string>()
  for (const p of parts) {
    const node = named.get(`bay:${p.bay}`)
    if (!node || drawn.has(p.bay)) continue
    const part = placedPart(p.scene, p.position)
    part.userData = { ...part.userData, danbyteBay: p.bay }
    node.add(part)
    drawn.add(p.bay)
  }
  const covers = [...named.keys()]
    .map((n) => parseAnchor(n)!)
    .filter((a) => a.kind === "empty")
    .map((a) => a.name)
  const shown = coverVisibility(covers, bays, drawn, mode)
  for (const [name, visible] of shown) {
    named.get(`empty:${name}`)!.visible = visible
  }
  return { root, drawn }
}

/** Where a part's local point lands in the chassis' frame once posed at
 * `bay` - the bay node's transform applied (for tests and port maths). */
export function posedPoint(
  chassis: THREE.Object3D,
  bay: string,
  local: [number, number, number]
): THREE.Vector3 | null {
  const node = namedNodes(chassis).get(`bay:${bay}`)
  if (!node) return null
  chassis.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(chassis.matrixWorld).invert()
  const m = new THREE.Matrix4().multiplyMatrices(inv, node.matrixWorld)
  return new THREE.Vector3(...local).applyMatrix4(m)
}
