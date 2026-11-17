import { useEffect, useMemo } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"

import { recolourChannel } from "@/lib/fibre-colours"
import type { RecolourChannel } from "@/lib/fibre-colours"

import { useDeviceModel } from "./device-model"
import { partMeshes, receptacleMatrix } from "./port-plugs"

/**
 * A pluggable part as the room draws it, for the Pluggables page and the
 * interface page's thumbnail (docs/dcim/pluggables.md): drawn beside the
 * viewer's model, in its frame (model-viewer `overlay`).
 *
 * - The part's own `CABLE` / `FIBRE` / `LC_BODY` materials take `colours`
 *   (lib/fibre-colours), on copies: the model cache's stay untouched.
 * - With `cord`, the cord is seated at the part's `port:<connector>` empty
 *   - the first of `cord.names` it has, else its one `port:` empty - as
 *   port-plugs seats it in a device (receptacleMatrix, the empty's frame
 *   turned by EMPTY_TO_PART), or at the part's own origin without one.
 *
 * Default export for `lazy()`: three.js stays in the 3D chunk.
 */
export interface PartOverlayProps {
  root: THREE.Object3D
  colours: Record<RecolourChannel, string>
  cord?: { url: string; names: readonly string[] } | null
}

function tinted(
  mat: THREE.Material,
  colours: Record<RecolourChannel, string>,
  made: THREE.Material[]
): THREE.Material {
  const ch = recolourChannel(mat.name)
  if (!ch) return mat
  const c = mat.clone()
  if ("color" in c && c.color instanceof THREE.Color) c.color.set(colours[ch])
  made.push(c)
  return c
}

function useRecoloured(
  root: THREE.Object3D,
  colours: Record<RecolourChannel, string>
) {
  const invalidate = useThree((s) => s.invalidate)
  const key = `${colours.cable}|${colours.fibre}|${colours.lc}`
  useEffect(() => {
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = []
    const made: THREE.Material[] = []
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (!mats.some((m) => recolourChannel(m.name))) return
      swapped.push([o, o.material])
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => tinted(m, colours, made))
        : tinted(o.material, colours, made)
    })
    invalidate()
    return () => {
      for (const [m, mat] of swapped) m.material = mat
      made.forEach((m) => m.dispose())
      invalidate()
    }
    // `key` stands for `colours`.
  }, [root, key, invalidate])
}

function Cord({
  root,
  url,
  names,
  colours,
}: {
  root: THREE.Object3D
  url: string
  names: readonly string[]
  colours: Record<RecolourChannel, string>
}) {
  const entry = useDeviceModel(url)
  const scene = entry?.status === "ready" ? entry.scene : null
  const seat = useMemo(
    () => receptacleMatrix(root, names) ?? new THREE.Matrix4(),
    [root, names]
  )
  const key = `${colours.cable}|${colours.fibre}|${colours.lc}`
  const meshes = useMemo(() => {
    if (!scene) return []
    return partMeshes(scene).map((pm) => {
      let material = pm.material
      if (pm.channel && !Array.isArray(pm.material)) {
        const c = pm.material.clone()
        if ("color" in c && c.color instanceof THREE.Color)
          c.color.set(colours[pm.channel])
        material = c
      }
      return { ...pm, material, own: material !== pm.material }
    })
    // `key` stands for `colours`.
  }, [scene, key])
  useEffect(
    () => () =>
      meshes.forEach((m) => {
        if (m.own && !Array.isArray(m.material)) m.material.dispose()
      }),
    [meshes]
  )
  if (!scene) return null
  return (
    <group matrixAutoUpdate={false} matrix={seat}>
      {meshes.map((m, i) => (
        <mesh
          key={i}
          geometry={m.geometry}
          material={m.material}
          matrixAutoUpdate={false}
          matrix={m.local}
          raycast={() => {}}
          castShadow
          receiveShadow
        />
      ))}
    </group>
  )
}

export default function PartOverlay({ root, colours, cord }: PartOverlayProps) {
  useRecoloured(root, colours)
  if (!cord) return null
  return (
    <Cord root={root} url={cord.url} names={cord.names} colours={colours} />
  )
}
