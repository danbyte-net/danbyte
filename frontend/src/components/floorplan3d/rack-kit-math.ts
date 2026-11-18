/**
 * The arithmetic of a drawn rack (docs/dcim/racks.md → Look, the export
 * spec §14): where its rails sit, how a kit's parts stretch and repeat to
 * the rack's own size, which units the blanking fill takes, and how far a
 * door has swung. Pure - rack-shell and rack-kit draw from it.
 *
 * Frames: the rack group's, as rack-mesh draws it - metres, x across with
 * 0 the centre, y up from the floor, the front plane on −Z.
 */
import * as THREE from "three"

import { OPENING_MM, PANEL_MM } from "@/lib/faceplate-geometry"

import { RACK_BASE_M, mm, rackRailPlanesM } from "./world"
import type { SceneDevice, SceneRack } from "./world"

export type RackFrame = "2-post" | "4-post" | "cabinet" | "wall-cabinet"
export type RackDoor =
  "none" | "perforated" | "glass" | "solid" | "split-perforated" | "split-solid"

/** A kit as the scene carries it (api.rack_kits.kit_doc). */
export interface SceneKit {
  id: string
  name: string
  frame: RackFrame
  parts: Record<
    string,
    { stretch: string; ref_mm: number | null; hinge: boolean }
  >
  colours: Record<string, string>
  model_url: string | null
  far_url: string | null
}

/** A rack's resolved Look as the scene carries it (api.scene_geo). */
export interface SceneLook {
  frame: RackFrame
  rail_depth_mm: number | null
  front_door: RackDoor
  rear_door: RackDoor
  hinge: "left" | "right"
  side_panels: boolean
  top: "vented" | "solid" | "fans" | "brush"
  base: "plinth" | "casters" | "feet"
  /** Hex. */
  colour: string
  kit: SceneKit | null
  blanking_fill: boolean
  /** The tenant's blanking panels with a model, when the fill is on. */
  blanks: { u_height: number; name: string; model_url: string }[]
}

/** What a rack without a Look in its payload (an older cached scene)
 * draws: Danbyte's cabinet, smoked glass both sides, as before. */
export const LEGACY_LOOK: SceneLook = {
  frame: "cabinet",
  rail_depth_mm: null,
  front_door: "glass",
  rear_door: "glass",
  hinge: "left",
  side_panels: true,
  top: "solid",
  base: "plinth",
  colour: "#18181b",
  kit: null,
  blanking_fill: false,
  blanks: [],
}

export function isEnclosed(frame: RackFrame): boolean {
  return frame === "cabinet" || frame === "wall-cabinet"
}

/** The rack's mounting rail planes (z, m) - world `rackRailPlanesM`:
 * racked gear stands on them too (`deviceBoxM`, rack-models
 * `rackSlotPose`). */
export const railPlanesM = rackRailPlanesM

// ── stretching ──────────────────────────────────────────────────────────────

/**
 * One axis of a kit part, mapped from the reference cabinet to this rack:
 * a part that is not stretched along it keeps its size and moves with the
 * nearer edge of the cabinet (a corner, a hinge, a caster); a stretched
 * part keeps the distance of both its ends to the edges, so it grows with
 * the cabinet. `[min, max]` is the part's extent, `ref` the reference
 * cabinet's and `target` this rack's.
 */
export function mapAxis(
  min: number,
  max: number,
  ref: readonly [number, number],
  target: readonly [number, number],
  stretched: boolean
): { centre: number; scale: number } {
  const [rLo, rHi] = ref
  const [tLo, tHi] = target
  if (stretched && max > min) {
    const a = min - rLo + tLo
    const b = max - rHi + tHi
    if (b > a) return { centre: (a + b) / 2, scale: (b - a) / (max - min) }
  }
  const c = (min + max) / 2
  const nearLo = c - rLo <= rHi - c
  return { centre: nearLo ? c - rLo + tLo : c - rHi + tHi, scale: 1 }
}

/** The matrix taking a part whose box is `box` (rack frame, reference
 * cabinet) to this rack: per axis `mapAxis`, stretched along `stretch`
 * (glTF letters as Blender writes them: Blender's y is depth, z height). */
export function partMatrix(
  box: THREE.Box3,
  ref: THREE.Box3,
  target: THREE.Box3,
  stretch: string
): THREE.Matrix4 {
  const along = {
    x: stretch.includes("x"),
    // Blender z (up) is three's y; Blender y (depth) is three's z.
    y: stretch.includes("z"),
    z: stretch.includes("y"),
  }
  const ax = mapAxis(
    box.min.x,
    box.max.x,
    [ref.min.x, ref.max.x],
    [target.min.x, target.max.x],
    along.x
  )
  const ay = mapAxis(
    box.min.y,
    box.max.y,
    [ref.min.y, ref.max.y],
    [target.min.y, target.max.y],
    along.y
  )
  const az = mapAxis(
    box.min.z,
    box.max.z,
    [ref.min.z, ref.max.z],
    [target.min.z, target.max.z],
    along.z
  )
  const c = box.getCenter(new THREE.Vector3())
  return new THREE.Matrix4()
    .makeTranslation(ax.centre, ay.centre, az.centre)
    .multiply(new THREE.Matrix4().makeScale(ax.scale, ay.scale, az.scale))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
}

/**
 * A stretched part's texture repeat, so its perforation keeps its real
 * size: the kit gives `base` repeats over `refMm` (§14: 1000 mm worth);
 * the part is now `lengthMm` long. Without a transform of its own
 * (`base` 1) and with the material's `tileMm`, one tile per `tileMm`.
 */
export function stretchedRepeat(
  base: number,
  lengthMm: number,
  refMm: number | null,
  tileMm?: number | null
): number {
  if (base === 1 && tileMm && tileMm > 0) return lengthMm / tileMm
  return base * (lengthMm / (refMm && refMm > 0 ? refMm : 1000))
}

// ── posts ───────────────────────────────────────────────────────────────────

/** Where a rack's posts stand (x, z of the rail face, m) and which side
 * they are mirrored to: front left and right on the front rail, rear on
 * the rear one; a 2-post frame has the two mid-depth. */
export interface PostSpot {
  x: number
  z: number
  mirrorX: boolean
  mirrorZ: boolean
}

export function postSpots(
  frame: RackFrame,
  widthM: number,
  rails: { front: number; rear: number },
  /** How far in from the side the post's outer face stands (m). */
  insetM: number
): PostSpot[] {
  const x = -widthM / 2 + insetM
  const front: PostSpot[] = [
    { x, z: rails.front, mirrorX: false, mirrorZ: false },
    { x: -x, z: rails.front, mirrorX: true, mirrorZ: false },
  ]
  if (frame === "2-post") return front
  return [
    ...front,
    { x, z: rails.rear, mirrorX: false, mirrorZ: true },
    { x: -x, z: rails.rear, mirrorX: true, mirrorZ: true },
  ]
}

/**
 * Every post segment's matrix: the reference `post:segment` (its box
 * `seg` in the rack frame, its rail face its front, min z) repeated once
 * per unit at each post spot, the unit's bottom on that unit's line. A
 * spot on the right is the segment mirrored in x; one at the rear,
 * mirrored in z - so the matrices of mirrored posts have a negative
 * determinant (rack-kit draws those with a mirrored geometry).
 */
export function postSegmentMatrices(
  seg: THREE.Box3,
  spots: readonly PostSpot[],
  units: number
): THREE.Matrix4[] {
  const pitch = mm(PANEL_MM.uPitch)
  // The segment's outer side and rail face, as modelled (a left post).
  const ox = seg.min.x
  const oz = seg.min.z
  const out: THREE.Matrix4[] = []
  for (const s of spots) {
    for (let u = 0; u < units; u++) {
      const m = new THREE.Matrix4()
        .makeTranslation(s.x, RACK_BASE_M + u * pitch, s.z)
        .multiply(
          new THREE.Matrix4().makeScale(
            s.mirrorX ? -1 : 1,
            1,
            s.mirrorZ ? -1 : 1
          )
        )
        .multiply(new THREE.Matrix4().makeTranslation(-ox, -seg.min.y, -oz))
      out.push(m)
    }
  }
  return out
}

// ── blanking fill ───────────────────────────────────────────────────────────

/** The empty units the blanking fill covers: runs of front units no
 * device takes, each split into the largest panels `sizes` has (2U, then
 * 1U). `u` is the panel's bottom unit counted from the rack's bottom
 * (0-based). Draw-only: none of this is a device. */
export function blankingSlots(
  rack: Pick<SceneRack, "u_height" | "starting_unit" | "desc_units">,
  devices: readonly Pick<
    SceneDevice,
    "position" | "u_height" | "face" | "is_full_depth"
  >[],
  sizes: readonly number[] = [2, 1]
): { u: number; h: number }[] {
  const taken = new Array<boolean>(rack.u_height).fill(false)
  for (const d of devices) {
    const position = d.position
    if (position == null) continue
    if (d.face === "rear" && !d.is_full_depth) continue
    const units = Math.max(d.u_height, 1)
    for (let k = 0; k < units; k++) {
      const idx: number = position - rack.starting_unit + k
      const fromBottom = rack.desc_units ? rack.u_height - 1 - idx : idx
      if (fromBottom >= 0 && fromBottom < rack.u_height)
        taken[fromBottom] = true
    }
  }
  const sorted = [...new Set(sizes.filter((s) => s >= 1))].sort((a, b) => b - a)
  if (!sorted.includes(1)) sorted.push(1)
  const out: { u: number; h: number }[] = []
  let u = 0
  while (u < rack.u_height) {
    if (taken[u]) {
      u += 1
      continue
    }
    let run = 0
    while (u + run < rack.u_height && !taken[u + run]) run += 1
    let at = u
    let left = run
    for (const s of sorted) {
      while (left >= s) {
        out.push({ u: at, h: s })
        at += s
        left -= s
      }
    }
    u += run
  }
  return out
}

/** The rail opening of a rack (m). */
export function openingM(rack: Pick<SceneRack, "width">): number {
  return mm(OPENING_MM[rack.width] ?? PANEL_MM.opening)
}

// ── doors ───────────────────────────────────────────────────────────────────

/** How far an open door swings (rad). */
export const DOOR_OPEN_RAD = (100 * Math.PI) / 180
/** How long a door takes to swing fully (s). */
export const DOOR_SWING_S = 0.45

/** The leaves of a door across `widthM`: one, or two for a split door,
 * each with the x of its hinge edge and which way it swings (+1: about
 * +Y, opening toward the viewer on a front door hinged left). */
export function doorLeaves(
  door: RackDoor,
  widthM: number,
  hinge: "left" | "right"
): { x: number; w: number; hingeX: number; sign: 1 | -1 }[] {
  if (door === "none") return []
  const half = widthM / 2
  if (door.startsWith("split-")) {
    return [
      { x: -half / 2, w: half, hingeX: -half, sign: 1 },
      { x: half / 2, w: half, hingeX: half, sign: -1 },
    ]
  }
  return hinge === "left"
    ? [{ x: 0, w: widthM, hingeX: -half, sign: 1 }]
    : [{ x: 0, w: widthM, hingeX: half, sign: -1 }]
}

/** The door's angle after `dt` seconds swinging toward `open`: a constant
 * swing over DOOR_SWING_S, or straight there with reduced motion. */
export function stepDoor(
  angle: number,
  open: boolean,
  dt: number,
  reducedMotion: boolean
): number {
  const target = open ? DOOR_OPEN_RAD : 0
  if (reducedMotion) return target
  const step = (DOOR_OPEN_RAD / DOOR_SWING_S) * Math.max(0, dt)
  if (Math.abs(target - angle) <= step) return target
  return angle + Math.sign(target - angle) * step
}

/** The base layer a door type is drawn with. */
export function doorInfill(door: RackDoor): "perforated" | "glass" | "solid" {
  if (door === "glass") return "glass"
  if (door === "solid" || door === "split-solid") return "solid"
  return "perforated"
}
