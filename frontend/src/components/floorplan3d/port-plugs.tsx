import { useLayoutEffect, useMemo } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"

import { parseAnchor } from "@/lib/model-assembly"
import {
  PLUG_NODE,
  RECOLOURED_MATERIALS,
  plugColor,
  plugGroups,
  plugsKey,
  shownMeshes,
} from "@/lib/port-plugs"
import type { PortPlug } from "@/lib/port-plugs"

import { useDeviceModels } from "./device-model"
import type { ModelEntry } from "./device-model"

/**
 * Plugs seated in a device's cabled ports (docs/dcim/model-packs.md →
 * Accessory types, export spec §13): each plug the server names
 * (lib/port-plugs) drawn at its `port:` anchor of the assembled model.
 *
 * A part is authored like the anchor - origin at the port opening, +Z out
 * along the cable, +Y up - so seating it is copying the anchor's transform.
 * Parts load through the device model cache (one download per part for the
 * whole room) and draw instanced: ONE InstancedMesh per mesh of a part for
 * every port that takes it, so a switch with 48 RJ45 plugs costs the
 * plug's few draw calls. The cable-coloured materials (`CABLE`, `FIBRE`)
 * are cloned once per source material in white and take each plug's cable
 * colour as its instance colour; every other material is the part's own.
 *
 * A port that holds a recorded transceiver but no cable draws the part
 * without its child named `plug` (the connector and its stub); a one-piece
 * part - a DAC, a generic plug - has none and is not drawn there.
 *
 * Plugs never take the pointer: the port markers reach over them, so a
 * plug hovers and right-clicks as the port it sits in (port-pick).
 */

/** A part's mesh with its matrix in the part's own frame. */
interface PartMesh {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  local: THREE.Matrix4
  recolour: boolean
  /** Under the part's `plug` child: drawn only while cabled. */
  inPlug: boolean
}

/** The white clones of recoloured materials, per source material. Freed
 * with the source (a WeakMap): the model cache disposes the source. */
const whiteClones = new WeakMap<THREE.Material, THREE.Material>()

function whiteOf(mat: THREE.Material): THREE.Material {
  let w = whiteClones.get(mat)
  if (!w) {
    w = mat.clone()
    if ("color" in w && w.color instanceof THREE.Color) w.color.set("#ffffff")
    whiteClones.set(mat, w)
  }
  return w
}

const recoloured = (m: THREE.Material) => RECOLOURED_MATERIALS.has(m.name)

/** Whether `o` is, or sits under, the part's `plug` child. */
function underPlug(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n && n !== root; n = n.parent) {
    const name =
      typeof n.userData.gltfName === "string" ? n.userData.gltfName : n.name
    if (PLUG_NODE.test(name)) return true
  }
  return false
}

/** The meshes of a loaded part, each with its matrix in the part's frame. */
export function partMeshes(scene: THREE.Object3D): PartMesh[] {
  scene.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert()
  const out: PartMesh[] = []
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    const recolour = mats.some(recoloured)
    out.push({
      geometry: o.geometry,
      material: recolour
        ? Array.isArray(o.material)
          ? o.material.map((m) => (recoloured(m) ? whiteOf(m) : m))
          : whiteOf(o.material)
        : o.material,
      local: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld),
      recolour,
      inPlug: underPlug(o, scene),
    })
  })
  return out
}

/** Each plug's anchor matrix in `root`'s frame, or null where the model
 * has no such anchor: the chassis' `port:` nodes outside any posed part,
 * a module's inside the part posed at its bay (model-assembly tags the
 * part's root `danbyteBay`; its names have `{module}` resolved). */
export function anchorMatrices(
  root: THREE.Object3D,
  plugs: readonly Pick<PortPlug, "port" | "bay">[]
): (THREE.Matrix4 | null)[] {
  const byBay = new Map<string | null, Map<string, THREE.Object3D>>()
  const walk = (o: THREE.Object3D, bay: string | null) => {
    const here =
      typeof o.userData.danbyteBay === "string" ? o.userData.danbyteBay : bay
    const n = o.userData.gltfName
    if (typeof n === "string") {
      const a = parseAnchor(n)
      if (a?.kind === "port") {
        let m = byBay.get(here)
        if (!m) byBay.set(here, (m = new Map()))
        if (!m.has(a.name)) m.set(a.name, o)
      }
    }
    o.children.forEach((c) => walk(c, here))
  }
  walk(root, null)
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  return plugs.map((p) => {
    const node = byBay.get(p.bay ?? null)?.get(p.port)
    return node
      ? new THREE.Matrix4().multiplyMatrices(inv, node.matrixWorld)
      : null
  })
}

const _m = new THREE.Matrix4()
const _c = new THREE.Color()

/** One part's plugs on one model, instanced. */
function PartPlugs({
  entry,
  plugs,
  anchors,
  cabled,
}: {
  entry: ModelEntry
  plugs: readonly PortPlug[]
  anchors: readonly THREE.Matrix4[]
  /** The ports are cabled: the whole part, else the body only. */
  cabled: boolean
}) {
  const invalidate = useThree((s) => s.invalidate)
  const meshes = useMemo(
    () => shownMeshes(partMeshes(entry.scene!), cabled),
    [entry.scene, cabled]
  )
  const count = anchors.length
  const instanced = useMemo(
    () =>
      meshes.map((pm) => {
        const im = new THREE.InstancedMesh(pm.geometry, pm.material, count)
        im.raycast = () => {}
        im.castShadow = false
        im.receiveShadow = true
        return im
      }),
    [meshes, count]
  )
  useLayoutEffect(
    () => () => instanced.forEach((im) => im.dispose()),
    [instanced]
  )
  useLayoutEffect(() => {
    instanced.forEach((im, k) => {
      anchors.forEach((a, i) => {
        im.setMatrixAt(i, _m.multiplyMatrices(a, meshes[k].local))
        if (meshes[k].recolour)
          im.setColorAt(i, _c.set(plugColor(plugs[i].color)))
      })
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
      im.computeBoundingSphere()
    })
    invalidate()
  }, [instanced, meshes, anchors, plugs, invalidate])
  return (
    <>
      {instanced.map((im) => (
        <primitive key={im.uuid} object={im} />
      ))}
    </>
  )
}

/**
 * The plugs of one placed model, in its assembled root's frame (mounted
 * beside the root, as PlacedModel's overlay is). Draws nothing until a
 * part has loaded; a plug whose anchor the model lacks is left out.
 */
export function PortPlugs({
  root,
  plugs,
}: {
  root: THREE.Object3D
  plugs: readonly PortPlug[]
}) {
  const key = plugsKey({ plugs: [...plugs] })
  // Keyed on the values: a poll with the same plugs keeps the draws.
  const groups = useMemo(() => {
    const out: {
      url: string
      cabled: boolean
      plugs: PortPlug[]
      anchors: THREE.Matrix4[]
    }[] = []
    for (const { url, cabled, plugs: list } of plugGroups(plugs)) {
      const mats = anchorMatrices(root, list)
      const kept = list.filter((_, i) => mats[i] !== null)
      if (kept.length)
        out.push({
          url,
          cabled,
          plugs: kept,
          anchors: mats.filter((m): m is THREE.Matrix4 => m !== null),
        })
    }
    return out
    // `key` stands for `plugs`.
  }, [root, key])
  const entries = useDeviceModels(groups.map((g) => g.url))
  return (
    <>
      {groups.map((g) => {
        const e = entries.get(g.url)
        if (e?.status !== "ready" || !e.scene) return null
        return (
          <PartPlugs
            key={`${g.url}:${g.cabled}`}
            entry={e}
            plugs={g.plugs}
            anchors={g.anchors}
            cabled={g.cabled}
          />
        )
      })}
    </>
  )
}
