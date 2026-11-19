import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import * as THREE from "three"

import { PANEL_MM } from "@/lib/faceplate-geometry"

import { doorKey } from "./door-state"
import { useDeviceModel } from "./device-model"
import { SwingDoor } from "./rack-shell"
import {
  doorInfill,
  boxToBox,
  doorLeaves,
  isEnclosed,
  partMatrix,
  postEndMatrices,
  postSegmentMatrices,
  postSpotsAt,
  railPlanesM,
  referenceBox,
  stretchedRepeat,
} from "./rack-kit-math"
import type { PostSpot, SceneKit, SceneLook } from "./rack-kit-math"
import { RACK_BASE_M, TRANSPARENT_ORDER, mm } from "./world"

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
  /** The `channel:0u:` empty a part (a `pdu:bracket`) hangs from. */
  channel?: string
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
  const visit = (o: THREE.Object3D, channel?: string) => {
    const raw =
      typeof o.userData.gltfName === "string" ? o.userData.gltfName : o.name
    const name = partName(String(raw))
    // A 0U channel is an empty (the room seats devices on it, world
    // kitChannelSeat); its `pdu:bracket` is a part of its own.
    if (CHANNEL_RE.test(name)) {
      o.children.forEach((c) => visit(c, name))
      return
    }
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
          ...(channel ? { channel } : {}),
        })
      }
      return
    }
    o.children.forEach((c) => visit(c, channel))
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
    if (!part.name.startsWith("door:") && !part.name.startsWith("path:"))
      ref.union(part.box)
  const out = { ref, parts }
  indexCache.set(scene, out)
  return out
}

const CHANNEL_RE = /^channel:0u:(left|right):(front|rear)$/

/** The parts that outline the kit's frame: not a door (it swings), a
 * strip, a bracket or a pathway (inside it, or beside a 2-post). */
function isFramePart(name: string): boolean {
  return !/^(door|label|pdu|path):/.test(name)
}

/**
 * The kit's reference rack in the rack frame (front at small z): `box`
 * its outer box - its first width across, centred, its first depth back
 * from its front (the glTF z = 0 plane of §14, or a frame part standing
 * ahead of it: a 2-post's base plate), from the floor up to the top of
 * its top unit - `u1` unit 1's bottom, `units` its units, `railZ` its
 * front rail's face. What every part is mapped from (`partMatrix`).
 */
export interface KitReference {
  box: THREE.Box3
  u1: number
  units: number
  railZ: number
}

export function kitReference(
  index: KitIndex,
  widthM: number | null,
  depthM: number | null
): KitReference {
  const pitch = mm(PANEL_MM.uPitch)
  const frame = new THREE.Box3()
  for (const p of index.parts) if (isFramePart(p.name)) frame.union(p.box)
  if (frame.isEmpty()) frame.copy(index.ref)
  const seg = index.parts.find((p) => p.name === "post:segment")
  const u1 = seg ? seg.box.min.y : 0
  const end = index.parts.find((p) => p.name === "post:top")
  // Without end pieces: the whole units below the roof (or the frame's top).
  const roofs = index.parts.filter((p) => p.name.startsWith("top:"))
  const over = roofs.length
    ? Math.min(...roofs.map((p) => p.box.min.y))
    : frame.max.y
  const units = end
    ? Math.max(1, Math.round((end.box.min.y - u1) / pitch))
    : Math.max(1, Math.floor((over - u1) / pitch + 0.02))
  const front = Math.min(0, frame.min.z)
  const w = widthM ?? frame.max.x - frame.min.x
  const d = depthM ?? frame.max.z - front
  return {
    box: new THREE.Box3(
      new THREE.Vector3(-w / 2, 0, front),
      new THREE.Vector3(w / 2, u1 + units * pitch, front + d)
    ),
    u1,
    units,
    railZ: seg ? seg.box.min.z : front,
  }
}

/**
 * Where a kit's reference rack lands in this rack (the rack frame): a
 * cabinet or wall cabinet fills its outer box; an open frame is as wide
 * as its kit (moved out for a wider rail, `shiftM` each side) and as
 * deep as its rails - the front rail at the kit's inset behind its front,
 * a 4-post's rear rail as far ahead of its rear (the kit's rear members
 * are its front ones turned round), a 2-post's depth the kit's. Its top
 * is the top of the top unit, `topY`.
 */
export function kitTarget(
  ref: KitReference,
  frame: SceneLook["frame"],
  w: number,
  d: number,
  rails: { front: number; rear: number },
  topY: number,
  shiftM = 0
): THREE.Box3 {
  if (isEnclosed(frame))
    return new THREE.Box3(
      new THREE.Vector3(-w / 2, 0, -d / 2),
      new THREE.Vector3(w / 2, topY, d / 2)
    )
  const inset = ref.railZ - ref.box.min.z
  const depth = ref.box.max.z - ref.box.min.z
  const z0 = rails.front - inset
  const z1 = frame === "2-post" ? z0 + depth : rails.rear + inset
  return new THREE.Box3(
    new THREE.Vector3(ref.box.min.x - shiftM, 0, z0),
    new THREE.Vector3(ref.box.max.x + shiftM, topY, Math.max(z1, z0 + 0.01))
  )
}

/** The copies a frame member is drawn in (matrices applied after it is
 * mapped to the rack): the kit models one of each, the spec places them
 * at every corner - corners and feet at the four, a width beam front and
 * rear, a depth beam left and right - and a frame's beams again at its
 * bottom corners (`down`: the drop from its top corners to them). */
export function memberCopies(
  name: string,
  target: THREE.Box3,
  down: number | null,
  frame: SceneLook["frame"] = "cabinet"
): THREE.Matrix4[] {
  // A 2-post's one rail: its tie beam and base are single.
  if (frame === "2-post") return [new THREE.Matrix4()]
  const cz = (target.min.z + target.max.z) / 2
  const mx = mirrorAbout(0, (target.min.x + target.max.x) / 2)
  const mz = mirrorAbout(2, cz)
  const one = new THREE.Matrix4()
  const four = [one, mx, mz, mx.clone().multiply(mz)]
  let out: THREE.Matrix4[]
  if (/^(corner:(top|bottom)|base:(feet|casters))$/.test(name)) out = four
  else if (name === "beam:width") out = [one, mz]
  else if (name === "beam:depth") out = [one, mx]
  else return [one]
  if (down != null && name.startsWith("beam:")) {
    const t = new THREE.Matrix4().makeTranslation(0, down, 0)
    out = [...out, ...out.map((m) => t.clone().multiply(m))]
  }
  return out
}

const mirroredCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()

/** An attribute as plain floats: a quantized one (KHR_mesh_quantization:
 * unsigned shorts, normalised bytes) read through its normalisation. */
function floatAttribute(
  a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
): THREE.BufferAttribute {
  const out = new Float32Array(a.count * a.itemSize)
  for (let i = 0; i < a.count; i++)
    for (let k = 0; k < a.itemSize; k++)
      out[i * a.itemSize + k] = a.getComponent(i, k)
  return new THREE.BufferAttribute(out, a.itemSize)
}

/** `g` mirrored in x with its winding turned back, so an instance whose
 * matrix mirrors draws front faces out (instanced meshes don't flip the
 * winding the way a mesh with a mirrored matrix does). Positions, normals
 * and tangents are read as floats first: a pack's are quantized to
 * unsigned shorts, where a mirrored (negative) x wraps round to metres
 * away - the posts that went missing. Normals come out unit length; a
 * tangent's handedness turns with the mirror. */
export function mirroredGeometry(
  g: THREE.BufferGeometry
): THREE.BufferGeometry {
  const hit = mirroredCache.get(g)
  if (hit) return hit
  const m = g.clone()
  for (const key of ["position", "normal", "tangent"])
    if (m.hasAttribute(key))
      m.setAttribute(key, floatAttribute(m.getAttribute(key)))
  m.applyMatrix4(MIRROR_X)
  if (m.hasAttribute("tangent")) {
    const tan = m.getAttribute("tangent")
    if (tan.itemSize === 4) {
      for (let i = 0; i < tan.count; i++) tan.setW(i, -tan.getW(i))
      tan.needsUpdate = true
    }
  }
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
  // A wall cabinet's bottom is its enclosure, whatever its base says.
  if (look.frame === "wall-cabinet")
    pick("base", "panel", [look.base, "plinth", "plate"])
  else if (look.base !== "none") {
    if (look.frame === "2-post") pick("base", "plate", ["plinth", "feet"])
    // A base the kit hasn't got: one it has, so the frame still stands.
    else pick("base", look.base, ["plinth", "feet", "casters", "plate"])
  }
  if (isEnclosed(look.frame)) {
    if (look.top !== "none") pick("top", look.top, ["solid", "vented"])
    if (mode === "solid" && look.side_panels) {
      // Split (v1.15) when the kit has both pieces, else the whole panel.
      if (have.has("side:panel:edge") && have.has("side:panel:infill")) {
        out.add("side:panel:edge")
        out.add("side:panel:infill")
      } else out.add("side:panel")
    }
  }
  if (look.frame === "wall-cabinet") out.add("wall:bracket")
  return out
}

interface Draw {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  matrix: THREE.Matrix4
  /** See-through (the glass infill): drawn in the fixed glass order,
   * after the gear behind it, and casting no shadow. */
  renderOrder: number
}

/** A 0U channel a device is seated on, and the device's span (m). */
export interface KitSeat {
  name: string
  y: number
  h: number
}

/** Whether a material is drawn see-through (alpha BLEND: the spec's
 * tinted glass): transparent, not writing depth. MASK cutouts (the
 * perforation) stay opaque. */
export function seeThrough(mat: THREE.Material | THREE.Material[]): boolean {
  const all = Array.isArray(mat) ? mat : [mat]
  return all.some((m) => m.transparent && m.opacity < 1)
}

/** The mirror across the plane `axis` (0 x, 1 y, 2 z) = `at`. */
export function mirrorAbout(axis: 0 | 1 | 2, at: number): THREE.Matrix4 {
  const t = [0, 0, 0]
  t[axis] = at
  const k = [1, 1, 1]
  k[axis] = -1
  return new THREE.Matrix4()
    .makeTranslation(t[0], t[1], t[2])
    .multiply(new THREE.Matrix4().makeScale(k[0], k[1], k[2]))
    .multiply(new THREE.Matrix4().makeTranslation(-t[0], -t[1], -t[2]))
}

/** How one door leaf is built: from its split parts (spec v1.15: the
 * stile at the hinge edge and mirrored to the free one, the rail at the
 * bottom and mirrored to the top, the infill stretched between - frame
 * members keep their real size on any leaf) or, without them, the whole
 * leaf stretched. `ref` is the whole leaf's box in the reference cabinet;
 * each piece is mapped from it to the leaf's box, keeping its distance to
 * the leaf's edges. */
export interface LeafBuild {
  ref: THREE.Box3
  hinge: THREE.Vector3 | null
  pieces: { part: KitPart; stretch: string; mirrors: ("" | "x" | "y")[] }[]
}

export function doorParts(
  parts: readonly KitPart[],
  kind: "perforated" | "glass" | "solid"
): LeafBuild | null {
  const find = (n: string) => parts.find((p) => p.name === n)
  const whole =
    find(`door:${kind}`) ??
    parts.find((p) => /^door:(perforated|glass|solid)$/.test(p.name))
  const stile = find(`door:${kind}:stile`)
  const rail = find(`door:${kind}:rail`)
  const infill = find(`door:${kind}:infill`)
  if (stile && rail && infill) {
    let ref: THREE.Box3
    if (whole) ref = whole.box.clone()
    else {
      // The pieces, with the free edge's stile they leave out.
      ref = stile.box.clone().union(rail.box).union(infill.box)
      const c = (rail.box.min.x + rail.box.max.x) / 2
      const half = Math.max(ref.max.x - c, c - ref.min.x)
      ref.min.x = c - half
      ref.max.x = c + half
    }
    return {
      ref,
      hinge: stile.hinge ?? whole?.hinge ?? null,
      pieces: [
        { part: stile, stretch: stile.stretch || "z", mirrors: ["", "x"] },
        { part: rail, stretch: rail.stretch || "x", mirrors: ["", "y"] },
        { part: infill, stretch: infill.stretch || "xz", mirrors: [""] },
      ],
    }
  }
  if (!whole) return null
  return {
    ref: whole.box,
    hinge: whole.hinge,
    pieces: [{ part: whole, stretch: "xz", mirrors: [""] }],
  }
}

/** Where a post's U-number strip stands (rack frame, m): its centre
 * across and its face (`z`), facing the front (−Z) or the rear, from the
 * rack's base up its units; `y0` / `lh` the kit's strip within each unit
 * (from the unit's bottom, and its height). */
export interface LabelStrip {
  x: number
  z: number
  w: number
  facing: "front" | "rear"
  y0: number
  lh: number
  /** The strip's colour (the kit's label material, sRGB hex). */
  color: string
}

/** The kit's `label:u` (one unit of the strip, modelled beside the
 * reference post's holes) at every post spot, mirrored as its post. */
export function labelStrips(
  label: KitPart,
  seg: THREE.Box3,
  spots: readonly PostSpot[],
  units: number
): LabelStrip[] {
  if (units <= 0) return []
  const lb = label.box
  const dx = (lb.min.x + lb.max.x) / 2 - seg.min.x
  const dz = lb.min.z - seg.min.z
  const mat = label.meshes[0]?.material
  const first = Array.isArray(mat) ? mat[0] : mat
  const c = (first as THREE.MeshStandardMaterial | undefined)?.color
  const color = c ? `#${c.getHexString()}` : "#cccccc"
  return spots.map((s) => ({
    x: s.x + (s.mirrorX ? -dx : dx),
    // A hair off the rail face, toward the viewer.
    z: s.z + (s.mirrorZ ? -dz : dz) + (s.mirrorZ ? 0.0004 : -0.0004),
    w: lb.max.x - lb.min.x,
    facing: s.mirrorZ ? "rear" : "front",
    y0: Math.max(0, lb.min.y - seg.min.y),
    lh: lb.max.y - lb.min.y,
    color,
  }))
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
 * colour. Doors swing on their `hinge` empties when clicked. A seated
 * 0U device gets its channel's `pdu:bracket`; `numbering` prints the
 * rack's U numbers on the kit's `label:u` strips.
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
  seats = NO_SEATS,
  numbering = null,
  baseM = RACK_BASE_M,
  shiftM = 0,
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
  seats?: readonly KitSeat[]
  /** The rack's numbering, to print on the strips; null: blank strips. */
  numbering?: UNumbering | null
  /** Unit 1's bottom above the floor (world rackBaseM). */
  baseM?: number
  /** How far the posts move out each side for a rail wider than 19". */
  shiftM?: number
  fallback: React.ReactNode
}) {
  const entry = useDeviceModel(kit.model_url)
  const scene = entry?.status === "ready" ? entry.scene : null
  const built = useMemo(
    () =>
      scene
        ? buildKit(
            indexKit(scene, kitSizeM(kit.depths_mm)),
            rackId,
            look,
            units,
            w,
            h,
            d,
            color,
            mode,
            seats,
            {
              baseM,
              shiftM,
              widthM: kitSizeM(kit.widths_mm),
              depthM: kitSizeM(kit.depths_mm),
            }
          )
        : null,
    [
      scene,
      kit,
      rackId,
      look,
      units,
      w,
      h,
      d,
      color,
      mode,
      seats,
      baseM,
      shiftM,
    ]
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
          renderOrder={p.renderOrder}
          castShadow={p.renderOrder === 0}
          receiveShadow
        />
      ))}
      {built.labels.length > 0 && (
        <ULabels
          strips={built.labels}
          units={units}
          numbering={numbering}
          baseM={baseM}
        />
      )}
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
              renderOrder={p.renderOrder}
            />
          ))}
        </SwingDoor>
      ))}
    </group>
  )
}

const NO_SEATS: readonly KitSeat[] = []

/** A rack's unit numbering (the 2D elevation's): `start` the lowest unit
 * number, `desc` counting from the top. */
export interface UNumbering {
  start: number
  desc: boolean
}

/** The number unit row `i` (0 the bottom) shows (as the rack ruler). */
export function unitNumber(i: number, units: number, n: UNumbering): number {
  return n.desc ? n.start + units - 1 - i : n.start + i
}

/** The U-number strips: one canvas texture for the rack (a row per unit,
 * the kit's strip colour in each unit's label, its number on it) on one
 * plane per post, facing that post's aisle. Numbers off (`numbering`
 * null): the blank strips. Cutout alpha, so no transparency sort. */
function ULabels({
  strips,
  units,
  numbering,
  baseM,
}: {
  strips: readonly LabelStrip[]
  units: number
  numbering: UNumbering | null
  baseM: number
}) {
  const s0 = strips[0]
  const pitch = mm(PANEL_MM.uPitch)
  const texture = useMemo(() => {
    const W = 32
    const rowPx = 48
    const canvas = document.createElement("canvas")
    canvas.width = W
    canvas.height = units * rowPx
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    // A texel is s0.w / W wide and pitch / rowPx tall: text is drawn
    // squeezed by their ratio so it reads at its shape on the strip.
    const squeeze = s0.w / W / (pitch / rowPx)
    for (let i = 0; i < units; i++) {
      const top = (units - 1 - i) * rowPx // canvas y 0 is the top
      const y0 = top + rowPx - ((s0.y0 + s0.lh) / pitch) * rowPx
      const lh = (s0.lh / pitch) * rowPx
      ctx.fillStyle = s0.color
      ctx.fillRect(0, y0, W, lh)
      if (!numbering) continue
      const text = String(unitNumber(i, units, numbering))
      ctx.save()
      ctx.translate(W / 2, y0 + lh / 2)
      ctx.scale(1, squeeze)
      ctx.fillStyle = "#18181b"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      const size = Math.min(26, (W * 0.9) / (text.length * 0.62))
      ctx.font = `700 ${size}px ui-monospace, monospace`
      ctx.fillText(text, 0, 0)
      ctx.restore()
    }
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return t
  }, [units, numbering, s0, pitch])
  useEffect(() => () => texture?.dispose(), [texture])
  if (!texture) return null
  const h = units * pitch
  return (
    <group>
      {strips.map((s, i) => (
        <mesh
          key={i}
          position={[s.x, baseM + h / 2, s.z]}
          // A plane faces +Z; the front strips face the front (−Z).
          rotation={[0, s.facing === "front" ? Math.PI : 0, 0]}
          raycast={() => null}
        >
          <planeGeometry args={[s.w, h]} />
          <meshBasicMaterial map={texture} alphaTest={0.5} />
        </mesh>
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

/** A kit's reference size (m): the first of its listed widths or depths. */
function kitSizeM(sizes: number[] | undefined): number | null {
  const v = sizes?.[0]
  return typeof v === "number" && v > 0 ? v / 1000 : null
}

/** How a kit-built rack fits its room (rack-mesh): unit 1's bottom above
 * the floor (world rackBaseM), the kit's reference width and depth (its
 * first listed, m), and how far its posts move out each side for a rail
 * wider than 19" (m). */
export interface BuildOptions {
  baseM?: number
  widthM?: number | null
  depthM?: number | null
  shiftM?: number
}

/** Everything a kit-built rack draws, and what to dispose with it. */
export function buildKit(
  index: KitIndex,
  rackId: string,
  look: SceneLook,
  units: number,
  w: number,
  /** The rack's height; the kit's frame is built to its top unit
   * (`opts.baseM` and `units`) instead. */
  _h: number,
  d: number,
  color: string,
  mode: "solid" | "cutaway",
  /** The 0U channels a device is seated on (world sideStripBoxM): a
   * `pdu:bracket` is drawn behind each, as long as the device. */
  seats: readonly KitSeat[] = [],
  opts: BuildOptions = {}
) {
  const pitch = mm(PANEL_MM.uPitch)
  const baseM = opts.baseM ?? RACK_BASE_M
  const kref = kitReference(index, opts.widthM ?? null, opts.depthM ?? null)
  const rails = railPlanesM(d, look)
  const target = kitTarget(
    kref,
    look.frame,
    w,
    d,
    rails,
    baseM + units * pitch,
    opts.shiftM ?? 0
  )
  const owned: THREE.Material[] = []
  const materials = new Map<string, THREE.Material>()
  // The FRAME material in the rack's colour; a stretched texture at its
  // rescaled repeat. One copy per distinct look within this rack.
  type Lengths = { h: number | null; v: number | null; ref: number | null }
  // A kit's baked AO is left off: its parts are repeated (a post segment
  // per unit) or moved and stretched from where it was baked, so the bake
  // shows as dark patches and seams between units.
  const dress = (mat: THREE.Material, len: Lengths | null): THREE.Material => {
    const frame = mat.name === "FRAME"
    const ao = !!(mat as THREE.MeshStandardMaterial).aoMap
    if (!frame && !len && !ao) return mat
    const key = `${mat.uuid}|${len ? `${len.h?.toFixed(0)},${len.v?.toFixed(0)}` : ""}`
    const hit = materials.get(key)
    if (hit) return hit
    const m = mat.clone()
    if (ao) {
      ;(m as THREE.MeshStandardMaterial).aoMap = null
      m.needsUpdate = true
    }
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
  // A part drawn as plain meshes at `m` (rack frame), its texture repeat
  // for the size `m` gives it.
  const draw = (part: KitPart, m: THREE.Matrix4, into: Draw[] = plain) => {
    for (const pm of part.meshes) {
      const material = dressAll(pm.material, repeatOf(part, m))
      into.push({
        geometry: pm.geometry,
        material,
        matrix: m.clone().multiply(pm.matrix),
        renderOrder: seeThrough(material) ? TRANSPARENT_ORDER.glass : 0,
      })
    }
  }

  const seg = index.parts.find((p) => p.name === "post:segment")
  let labels: LabelStrip[] = []
  if (seg) {
    // The posts keep their place beside the rail opening (moved out for a
    // wider rail), whatever the rack's outer width.
    const spots = postSpotsAt(
      look.frame,
      seg.box.min.x - (opts.shiftM ?? 0),
      rails
    )
    const mats = postSegmentMatrices(seg.box, spots, units, baseM)
    for (const pm of seg.meshes) {
      const material = dressAll(pm.material, null)
      for (const m of mats)
        instance(pm, m.clone().multiply(pm.matrix), material)
    }
    // Each post's end pieces: the bottom one under unit 1, the top one
    // over the top unit, as the kit models them beside its segment.
    const ends: [string, number, number][] = [
      ["post:bottom", kref.u1, baseM],
      ["post:top", kref.u1 + kref.units * pitch, baseM + units * pitch],
    ]
    for (const [name, refY, y] of ends) {
      const part = index.parts.find((p) => p.name === name)
      if (!part || !wanted.has(name)) continue
      for (const m of postEndMatrices(seg.box, spots, refY, y)) draw(part, m)
    }
    const label = index.parts.find((p) => p.name === "label:u")
    if (label) labels = labelStrips(label, seg.box, spots, units)
  }

  // The drop from the frame's top corners to its bottom ones, for the
  // bottom beams.
  const cornerAt = (name: string) => {
    const c = index.parts.find((p) => p.name === name)
    return c
      ? c.box.clone().applyMatrix4(partMatrix(c.box, kref.box, target, "")).min
          .y
      : null
  }
  const topC = cornerAt("corner:top")
  const botC = cornerAt("corner:bottom")
  const down = topC != null && botC != null ? botC - topC : null

  // Parts modelled once for both sides: the other is the mirror image.
  const sides = (name: string) =>
    index.parts.filter((p) => p.name === name).length === 1
  // A split side panel's edge is its bottom one; the top is its mirror,
  // about the panel's height (its infill's).
  const infill = index.parts.find((p) => p.name === "side:panel:infill")
  for (const part of index.parts) {
    if (!wanted.has(part.name) || part.name.startsWith("post:")) continue
    const m = partMatrix(part.box, kref.box, target, part.stretch)
    let copies = memberCopies(part.name, target, down, look.frame).map((c) =>
      c.clone().multiply(m)
    )
    if (part.name === "side:panel:edge" && infill) {
      const panel = infill.box
        .clone()
        .applyMatrix4(partMatrix(infill.box, kref.box, target, infill.stretch))
        .union(part.box.clone().applyMatrix4(m))
      copies.push(mirrorAbout(1, (panel.min.y + panel.max.y) / 2).multiply(m))
    }
    if (part.name.startsWith("side:panel") && sides(part.name))
      copies = copies.flatMap((c) => [c, MIRROR_X.clone().multiply(c)])
    for (const c of copies) draw(part, c)
  }

  // A `pdu:bracket` behind each seated 0U device, as long as the device:
  // across and front to back as its channel moves, up the device's span.
  for (const seat of seats) {
    const bracket = index.parts.find(
      (p) => p.name === "pdu:bracket" && p.channel === seat.name
    )
    if (!bracket) continue
    const m = partMatrix(bracket.box, kref.box, target, "")
    const at = bracket.box.clone().applyMatrix4(m)
    const bh = at.max.y - at.min.y
    if (bh <= 1e-6 || seat.h <= 0) continue
    const fit = new THREE.Matrix4()
      .makeTranslation(0, seat.y, 0)
      .multiply(new THREE.Matrix4().makeScale(1, seat.h / bh, 1))
      .multiply(new THREE.Matrix4().makeTranslation(0, -at.min.y, 0))
    draw(bracket, fit.multiply(m))
  }

  const doors: DoorDraw[] = []
  if (mode === "solid" && isEnclosed(look.frame)) {
    const hardware = index.parts.filter((p) =>
      ["door:handle", "door:hinge", "door:lock"].includes(p.name)
    )
    for (const side of ["front", "rear"] as const) {
      const door = side === "front" ? look.front_door : look.rear_door
      if (door === "none") continue
      const kind = doorInfill(door)
      const leaf = doorParts(index.parts, kind)
      if (!leaf) continue
      // The whole leaf at this rack's size, as modelled (hinge side and
      // all): where its height and depth come from.
      const full = partMatrix(leaf.ref, kref.box, target, "xz")
      const mapped = leaf.ref.clone().applyMatrix4(full)
      const width = mapped.max.x - mapped.min.x
      // The modelled hinge side (rack frame x), from its hinge empty; as
      // you face the front your left is +x.
      const modelHinge = leaf.hinge
        ? new THREE.Vector3().copy(leaf.hinge).applyMatrix4(full).x
        : mapped.max.x
      const modelLeft = modelHinge > (mapped.min.x + mapped.max.x) / 2
      const leaves = doorLeaves(door, width, look.hinge)
      leaves.forEach((lf, i) => {
        // The leaf as you face it → the rack frame (front: x flips).
        const xs = side === "front" ? -1 : 1
        const hingeX = xs * lf.hingeX
        const centreX = xs * lf.x
        const wantLeftEdge = hingeX > centreX // hinge on +x side
        // The leaf's box, hinged on the modelled side; turned to its own
        // hinge side and to the rear after.
        const box = new THREE.Box3(
          new THREE.Vector3(centreX - lf.w / 2, mapped.min.y, mapped.min.z),
          new THREE.Vector3(centreX + lf.w / 2, mapped.max.y, mapped.max.z)
        )
        let turn = new THREE.Matrix4()
        if (wantLeftEdge !== modelLeft) turn = mirrorAbout(0, centreX)
        // The rear door is the front one turned to face the rear.
        if (side === "rear")
          turn = new THREE.Matrix4().makeScale(1, 1, -1).multiply(turn)
        const draws: Draw[] = []
        for (const piece of leaf.pieces) {
          const m = partMatrix(piece.part.box, leaf.ref, box, piece.stretch)
          for (const extra of piece.mirrors) {
            const c = (box.min.x + box.max.x) / 2
            const at =
              extra === "x"
                ? mirrorAbout(0, c)
                : extra === "y"
                  ? mirrorAbout(1, (box.min.y + box.max.y) / 2)
                  : new THREE.Matrix4()
            draw(piece.part, turn.clone().multiply(at).multiply(m), draws)
          }
        }
        // Hardware keeps its size and its distance to the leaf's nearer
        // edges (the handle at the free edge, hinges at the hinge edge).
        // The kit models one hinge, low on the leaf: a second as high.
        for (const hw of hardware) {
          const m = partMatrix(hw.box, leaf.ref, box, "")
          const at =
            hw.name === "door:hinge"
              ? [m, mirrorAbout(1, (box.min.y + box.max.y) / 2).multiply(m)]
              : [m]
          for (const c of at) draw(hw, turn.clone().multiply(c), draws)
        }
        const placed = box.clone().applyMatrix4(turn)
        doors.push({
          id: doorKey(rackId, side, i),
          side,
          hingeX,
          centreX,
          y: (placed.min.y + placed.max.y) / 2,
          z: side === "front" ? placed.min.z : placed.max.z,
          draws,
        })
      })
    }
  }

  return {
    instanced: [...groups.values()],
    plain,
    doors,
    labels,
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
