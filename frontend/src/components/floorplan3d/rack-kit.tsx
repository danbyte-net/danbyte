import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import * as THREE from "three"

import { doorKey } from "./door-state"
import { useDeviceModel } from "./device-model"
import { SwingDoor } from "./rack-shell"
import {
  doorInfill,
  boxToBox,
  doorLeaves,
  isEnclosed,
  partMatrix,
  postSegmentMatrices,
  postSpots,
  railPlanesM,
  referenceBox,
  stretchedRepeat,
} from "./rack-kit-math"
import type { SceneKit, SceneLook } from "./rack-kit-math"

/** Blender's ``.001`` suffix, dropped from a part's name (api.rack_kits). */
export function partName(name: string): string {
  return name.replace(/\.\d{3}$/, "")
}

/** glTF fronts face +Z (spec §3); the rack group's front faces −Z. */
const TO_RACK = new THREE.Matrix4().makeRotationY(Math.PI)
const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1)

interface PartMesh {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  /** The mesh in the rack frame of the reference cabinet. */
  matrix: THREE.Matrix4
}

interface KitPart {
  name: string
  stretch: string
  refMm: number | null
  /** Its box in the rack frame of the reference cabinet. */
  box: THREE.Box3
  meshes: PartMesh[]
  /** A door's `hinge` empty, in the rack frame. */
  hinge: THREE.Vector3 | null
  /** The part node's origin, in the rack frame. */
  origin: THREE.Vector3
}

interface KitIndex {
  ref: THREE.Box3
  parts: KitPart[]
}

const indexCache = new WeakMap<THREE.Object3D, KitIndex>()

/** A kit's parts by node, in the rack frame (cached per loaded scene).
 * `depthM`: the reference cabinet's outer depth (the kit's first depth),
 * for stretched parts delivered as 1000 mm meshes (`referenceBox`). */
export function indexKit(
  scene: THREE.Object3D,
  depthM: number | null = null
): KitIndex {
  const hit = indexCache.get(scene)
  if (hit) return hit
  scene.updateMatrixWorld(true)
  const parts: KitPart[] = []
  const ref = new THREE.Box3()
  const visit = (o: THREE.Object3D) => {
    const raw =
      typeof o.userData.gltfName === "string" ? o.userData.gltfName : o.name
    const name = partName(String(raw))
    if (name.includes(":")) {
      const meshes: PartMesh[] = []
      let hinge: THREE.Vector3 | null = null
      o.traverse((c) => {
        const cn = partName(String(c.userData.gltfName ?? c.name ?? ""))
        if (c !== o && cn === "hinge" && !hinge) {
          hinge = new THREE.Vector3()
            .setFromMatrixPosition(c.matrixWorld)
            .applyMatrix4(TO_RACK)
        }
        if (c instanceof THREE.Mesh) {
          meshes.push({
            geometry: c.geometry,
            material: c.material,
            matrix: TO_RACK.clone().multiply(c.matrixWorld),
          })
        }
      })
      if (meshes.length) {
        const box = new THREE.Box3()
        for (const m of meshes) {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
          box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrix))
        }
        const ud = o.userData as Record<string, unknown>
        parts.push({
          name,
          stretch: String(ud.danbyte_stretch ?? "").toLowerCase(),
          refMm:
            typeof ud.danbyte_ref_mm === "number" ? ud.danbyte_ref_mm : null,
          box,
          meshes,
          hinge,
          origin: new THREE.Vector3()
            .setFromMatrixPosition(o.matrixWorld)
            .applyMatrix4(TO_RACK),
        })
      }
      return
    }
    o.children.forEach(visit)
  }
  visit(scene)
  // Stretched parts delivered at 1000 mm, laid out at their reference
  // size first: up to the roof's underside, else the frame's top.
  const roofs = parts.filter((p) => p.name.startsWith("top:"))
  const fixedTop = parts
    .filter((p) => !p.stretch && !p.name.startsWith("door:"))
    .reduce((y, p) => Math.max(y, p.box.max.y), 0)
  const topY = roofs.length
    ? Math.min(...roofs.map((p) => p.origin.y))
    : fixedTop
  for (const part of parts) {
    const to = referenceBox(
      part.origin,
      part.box,
      part.stretch,
      part.refMm,
      depthM,
      topY
    )
    if (!to) continue
    const pre = boxToBox(part.box, to)
    for (const m of part.meshes) m.matrix = pre.clone().multiply(m.matrix)
    if (part.hinge) part.hinge.applyMatrix4(pre)
    part.box = to
  }
  for (const part of parts)
    if (!part.name.startsWith("door:")) ref.union(part.box)
  const out = { ref, parts }
  indexCache.set(scene, out)
  return out
}

const mirroredCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()

/** `g` mirrored in x with its winding turned back, so an instance whose
 * matrix mirrors draws front faces out (instanced meshes don't flip the
 * winding the way a mesh with a mirrored matrix does). */
export function mirroredGeometry(
  g: THREE.BufferGeometry
): THREE.BufferGeometry {
  const hit = mirroredCache.get(g)
  if (hit) return hit
  const m = g.clone()
  m.applyMatrix4(MIRROR_X)
  const idx = m.getIndex()
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]
      a[i + 1] = a[i + 2]
      a[i + 2] = t
    }
    idx.needsUpdate = true
  }
  mirroredCache.set(g, m)
  return m
}

/** Which of a kit's parts this rack's Look draws, for `mode`. */
export function wantedParts(
  look: SceneLook,
  have: ReadonlySet<string>,
  mode: "solid" | "cutaway"
): Set<string> {
  const out = new Set<string>([
    "post:top",
    "post:bottom",
    "beam:width",
    "beam:depth",
    "corner:top",
    "corner:bottom",
  ])
  const pick = (prefix: string, want: string, fallbacks: string[]) => {
    for (const n of [
      `${prefix}:${want}`,
      ...fallbacks.map((f) => `${prefix}:${f}`),
    ])
      if (have.has(n)) return out.add(n)
  }
  if (look.frame === "2-post") pick("base", "plate", ["plinth"])
  else pick("base", look.base, ["plinth", "plate"])
  if (isEnclosed(look.frame)) {
    pick("top", look.top, ["solid", "vented"])
    if (mode === "solid" && look.side_panels) out.add("side:panel")
  }
  if (look.frame === "wall-cabinet") out.add("wall:bracket")
  return out
}

interface Draw {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  matrix: THREE.Matrix4
}

interface DoorDraw {
  id: string
  side: "front" | "rear"
  hingeX: number
  centreX: number
  y: number
  z: number
  draws: Draw[]
}

/**
 * A rack built from its kit (docs/dcim/racks.md → Look, the export spec
 * §14): `post:segment` repeated once per unit at each post - every
 * segment of one mesh in one instanced draw - the frame's beams, corners,
 * top and base mapped from the reference cabinet to this rack's size
 * (stretched parts keep both ends' distance to the edges, the rest move
 * with the nearer edge; a stretched texture keeps its tile size), side
 * panels and doors in solid mode. The FRAME material takes the rack's
 * colour. Doors swing on their `hinge` empties when clicked.
 *
 * Null until the kit has loaded - the caller draws Danbyte's own rack
 * meanwhile.
 */
export function RackKitShell({
  rackId,
  kit,
  look,
  units,
  w,
  h,
  d,
  color,
  mode,
  fallback,
}: {
  rackId: string
  kit: SceneKit
  look: SceneLook
  units: number
  w: number
  h: number
  d: number
  color: string
  mode: "solid" | "cutaway"
  fallback: React.ReactNode
}) {
  const entry = useDeviceModel(kit.model_url)
  const scene = entry?.status === "ready" ? entry.scene : null
  const built = useMemo(
    () =>
      scene
        ? buildKit(
            indexKit(scene, kitDepthM(kit)),
            rackId,
            look,
            units,
            w,
            h,
            d,
            color,
            mode
          )
        : null,
    [scene, rackId, look, units, w, h, d, color, mode]
  )
  useEffect(() => () => built?.dispose(), [built])
  if (!built) return <>{fallback}</>
  return (
    <group>
      {built.instanced.map((g, i) => (
        <InstancedPart key={i} {...g} />
      ))}
      {built.plain.map((p, i) => (
        <mesh
          key={i}
          geometry={p.geometry}
          material={p.material}
          matrixAutoUpdate={false}
          matrix={p.matrix}
          castShadow
          receiveShadow
        />
      ))}
      {built.doors.map((door) => (
        <SwingDoor
          key={door.id}
          doorId={door.id}
          side={door.side}
          hingeX={door.hingeX}
          centreX={door.centreX}
          y={door.y}
          z={door.z}
          childOffset={[-door.hingeX, -door.y, -door.z]}
        >
          {door.draws.map((p, i) => (
            <mesh
              key={i}
              geometry={p.geometry}
              material={p.material}
              matrixAutoUpdate={false}
              matrix={p.matrix}
            />
          ))}
        </SwingDoor>
      ))}
    </group>
  )
}

function InstancedPart({
  geometry,
  material,
  matrices,
}: {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  matrices: THREE.Matrix4[]
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    matrices.forEach((mat, i) => m.setMatrixAt(i, mat))
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
    m.computeBoundingBox()
  }, [matrices])
  return (
    <instancedMesh
      key={matrices.length}
      ref={ref}
      args={[geometry, material, matrices.length]}
      castShadow
      receiveShadow
    />
  )
}

/** The kit's reference depth (m): its first listed depth. */
function kitDepthM(kit: SceneKit): number | null {
  const d = kit.depths_mm?.[0]
  return typeof d === "number" && d > 0 ? d / 1000 : null
}

/** Everything a kit-built rack draws, and what to dispose with it. */
export function buildKit(
  index: KitIndex,
  rackId: string,
  look: SceneLook,
  units: number,
  w: number,
  h: number,
  d: number,
  color: string,
  mode: "solid" | "cutaway"
) {
  const target = new THREE.Box3(
    new THREE.Vector3(-w / 2, 0, -d / 2),
    new THREE.Vector3(w / 2, h, d / 2)
  )
  const owned: THREE.Material[] = []
  const materials = new Map<string, THREE.Material>()
  // The FRAME material in the rack's colour; a stretched texture at its
  // rescaled repeat. One copy per distinct look within this rack.
  type Lengths = { h: number | null; v: number | null; ref: number | null }
  const dress = (mat: THREE.Material, len: Lengths | null): THREE.Material => {
    const frame = mat.name === "FRAME"
    if (!frame && !len) return mat
    const key = `${mat.uuid}|${len ? `${len.h?.toFixed(0)},${len.v?.toFixed(0)}` : ""}`
    const hit = materials.get(key)
    if (hit) return hit
    const m = mat.clone()
    if (frame && "color" in m)
      (m as THREE.MeshStandardMaterial).color.set(color)
    if (len) {
      const tile = Number(mat.userData.danbyte_tile_mm) || null
      for (const slot of [
        "map",
        "normalMap",
        "roughnessMap",
        "metalnessMap",
        "alphaMap",
      ]) {
        const rec = m as unknown as Record<string, THREE.Texture | null>
        const tex = rec[slot]
        if (!tex) continue
        const t = tex.clone()
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.repeat.set(
          len.h != null
            ? stretchedRepeat(tex.repeat.x, len.h, len.ref, tile)
            : tex.repeat.x,
          len.v != null
            ? stretchedRepeat(tex.repeat.y, len.v, len.ref, tile)
            : tex.repeat.y
        )
        t.needsUpdate = true
        rec[slot] = t
      }
    }
    owned.push(m)
    materials.set(key, m)
    return m
  }
  const dressAll = (
    mat: THREE.Material | THREE.Material[],
    len: Lengths | null
  ) => (Array.isArray(mat) ? mat.map((m) => dress(m, len)) : dress(mat, len))

  // A stretched part's lengths (mm) along its texture's two axes: the
  // stretched horizontal axis (u), and height (v).
  const repeatOf = (part: KitPart, matrix: THREE.Matrix4): Lengths | null => {
    if (!part.stretch) return null
    const size = part.box
      .clone()
      .applyMatrix4(matrix)
      .getSize(new THREE.Vector3())
    const horiz = part.stretch.includes("x")
      ? size.x
      : part.stretch.includes("y")
        ? size.z
        : null
    return {
      h: horiz != null ? horiz * 1000 : null,
      v: part.stretch.includes("z") ? size.y * 1000 : null,
      ref: part.refMm,
    }
  }

  const have = new Set(index.parts.map((p) => p.name))
  const wanted = wantedParts(look, have, mode)
  const plain: Draw[] = []
  const groups = new Map<
    string,
    {
      geometry: THREE.BufferGeometry
      material: THREE.Material | THREE.Material[]
      matrices: THREE.Matrix4[]
    }
  >()
  const instance = (
    pm: PartMesh,
    m: THREE.Matrix4,
    material: THREE.Material | THREE.Material[]
  ) => {
    const mirrored = m.determinant() < 0
    const geometry = mirrored ? mirroredGeometry(pm.geometry) : pm.geometry
    const mat = mirrored ? m.clone().multiply(MIRROR_X) : m
    const key = `${geometry.uuid}|${Array.isArray(material) ? material.map((x) => x.uuid).join(",") : material.uuid}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { geometry, material, matrices: [] }))
    g.matrices.push(mat)
  }

  const rails = railPlanesM(d, look)
  const seg = index.parts.find((p) => p.name === "post:segment")
  if (seg) {
    // The reference post's side inset, kept on every post of this rack.
    const inset = Math.max(0, seg.box.min.x - index.ref.min.x)
    const spots = postSpots(look.frame, w, rails, inset)
    const mats = postSegmentMatrices(seg.box, spots, units)
    for (const pm of seg.meshes) {
      const material = dressAll(pm.material, null)
      for (const m of mats)
        instance(pm, m.clone().multiply(pm.matrix), material)
    }
  }

  const sides = index.parts.filter((p) => p.name === "side:panel")
  for (const part of index.parts) {
    if (!wanted.has(part.name)) continue
    const m = partMatrix(part.box, index.ref, target, part.stretch)
    const copies = [m]
    // One side panel modelled: the other is its mirror image.
    if (part.name === "side:panel" && sides.length === 1)
      copies.push(MIRROR_X.clone().multiply(m))
    for (const c of copies) {
      for (const pm of part.meshes) {
        const full = c.clone().multiply(pm.matrix)
        plain.push({
          geometry: pm.geometry,
          material: dressAll(pm.material, repeatOf(part, c)),
          matrix: full,
        })
      }
    }
  }

  const doors: DoorDraw[] = []
  if (mode === "solid" && isEnclosed(look.frame)) {
    const hardware = index.parts.filter((p) =>
      ["door:handle", "door:hinge", "door:lock"].includes(p.name)
    )
    for (const side of ["front", "rear"] as const) {
      const door = side === "front" ? look.front_door : look.rear_door
      if (door === "none") continue
      const infill = doorInfill(door)
      const leafPart =
        index.parts.find((p) => p.name === `door:${infill}`) ??
        index.parts.find(
          (p) => p.name.startsWith("door:") && !hardware.includes(p)
        )
      if (!leafPart) continue
      const full = partMatrix(
        leafPart.box,
        index.ref,
        target,
        leafPart.stretch || "xz"
      )
      const mapped = leafPart.box.clone().applyMatrix4(full)
      const width = mapped.max.x - mapped.min.x
      // The modelled hinge side (rack frame x), from its hinge empty; as
      // you face the front your left is +x.
      const modelHinge = leafPart.hinge
        ? new THREE.Vector3().copy(leafPart.hinge).applyMatrix4(full).x
        : mapped.max.x
      const modelLeft = modelHinge > (mapped.min.x + mapped.max.x) / 2
      const leaves = doorLeaves(door, width, look.hinge)
      leaves.forEach((leaf, i) => {
        // The leaf as you face it → the rack frame (front: x flips).
        const xs = side === "front" ? -1 : 1
        const hingeX = xs * leaf.hingeX
        const centreX = xs * leaf.x
        const wantLeftEdge = hingeX > centreX // hinge on +x side
        const cx = (mapped.min.x + mapped.max.x) / 2
        let m = new THREE.Matrix4()
          .makeTranslation(centreX, 0, 0)
          .multiply(new THREE.Matrix4().makeScale(leaf.w / width, 1, 1))
          .multiply(new THREE.Matrix4().makeTranslation(-cx, 0, 0))
        if (wantLeftEdge !== modelLeft)
          m = new THREE.Matrix4()
            .makeTranslation(centreX, 0, 0)
            .multiply(MIRROR_X)
            .multiply(new THREE.Matrix4().makeTranslation(-centreX, 0, 0))
            .multiply(m)
        // The rear door is the front one turned to face the rear.
        if (side === "rear")
          m = new THREE.Matrix4().makeScale(1, 1, -1).multiply(m)
        const leafM = m.clone().multiply(full)
        const box = leafPart.box.clone().applyMatrix4(leafM)
        const draws: Draw[] = []
        for (const pm of leafPart.meshes)
          draws.push({
            geometry: pm.geometry,
            material: dressAll(pm.material, repeatOf(leafPart, leafM)),
            matrix: leafM.clone().multiply(pm.matrix),
          })
        for (const hw of hardware) {
          // Hardware moves with its leaf at its own size: where the leaf
          // puts its centre, mirrored with the leaf, never squeezed.
          const placed = partMatrix(hw.box, index.ref, target, "")
          const c = hw.box.getCenter(new THREE.Vector3()).applyMatrix4(placed)
          const at = c.clone().applyMatrix4(m)
          let hm = new THREE.Matrix4().makeTranslation(
            at.x - c.x,
            at.y - c.y,
            at.z - c.z
          )
          if (m.determinant() < 0)
            hm = hm.multiply(
              new THREE.Matrix4()
                .makeTranslation(c.x, c.y, c.z)
                .multiply(MIRROR_X)
                .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
            )
          hm.multiply(placed)
          for (const pm of hw.meshes)
            draws.push({
              geometry: pm.geometry,
              material: dressAll(pm.material, null),
              matrix: hm.clone().multiply(pm.matrix),
            })
        }
        doors.push({
          id: doorKey(rackId, side, i),
          side,
          hingeX,
          centreX,
          y: (box.min.y + box.max.y) / 2,
          z: side === "front" ? box.min.z : box.max.z,
          draws,
        })
      })
    }
  }

  return {
    instanced: [...groups.values()],
    plain,
    doors,
    dispose: () => {
      for (const m of owned) {
        for (const v of Object.values(m))
          if (v instanceof THREE.Texture) v.dispose()
        m.dispose()
      }
    },
  }
}

/**
 * A kit's far box (`model3d.far`): one simple model fitted to the rack's
 * outer box, the FRAME material in the rack's colour. Null until loaded -
 * the caller's plain frame box stands in.
 */
export function RackKitFar({
  url,
  w,
  h,
  d,
  color,
  fallback,
}: {
  url: string
  w: number
  h: number
  d: number
  color: string
  fallback: React.ReactNode
}) {
  const entry = useDeviceModel(url)
  const scene = entry?.status === "ready" ? entry.scene : null
  const fitted = useMemo(() => {
    if (!scene) return null
    const copy = scene.clone()
    const owned: THREE.Material[] = []
    copy.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        const next = mats.map((m: THREE.Material) => {
          if (m.name !== "FRAME") return m
          const c = m.clone()
          ;(c as THREE.MeshStandardMaterial).color.set(color)
          owned.push(c)
          return c
        })
        o.material = Array.isArray(o.material) ? next : next[0]
      }
    })
    const holder = new THREE.Group()
    holder.add(copy)
    holder.rotation.y = Math.PI
    holder.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(holder)
    const size = box.getSize(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    const outer = new THREE.Group()
    outer.add(holder)
    holder.position.set(-centre.x, -box.min.y, -centre.z)
    outer.scale.set(
      size.x > 0 ? w / size.x : 1,
      size.y > 0 ? h / size.y : 1,
      size.z > 0 ? d / size.z : 1
    )
    return { object: outer, dispose: () => owned.forEach((m) => m.dispose()) }
  }, [scene, w, h, d, color])
  useEffect(() => () => fitted?.dispose(), [fitted])
  if (!fitted) return <>{fallback}</>
  return <primitive object={fitted.object} />
}
