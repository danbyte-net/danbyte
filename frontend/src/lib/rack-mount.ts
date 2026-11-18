/**
 * How a device sits on a rack's rails (api.rack_mount, the export spec §3
 * and §8 "Rack mounting"). A device type's `rack_mount` block gives its
 * ear positions - where the faceplate stands in front of the ear plane, mm,
 * + toward the rack front - and a device picks one (`ear_position`, blank
 * for the type's default). `reversed` is the box turned round in its U,
 * its rear panel toward the rack front, that offset its rear face's.
 */

export type EarPosition = "front" | "mid" | "rear" | "reversed"
export type RailKind = "none" | "fixed" | "sliding"

/** A device type's stored `rack_mount` block. Null: not recorded. */
export interface RackMountBlock {
  ears: boolean
  positions: Partial<Record<EarPosition, number>>
  default: EarPosition | ""
  rails: RailKind
  /** The ear plate's thickness (mm); left out, `EAR_PLATE_MM`. */
  ear_mm?: number
}

/** What the server works out for one device (`rack_mount` on a device and
 * on a scene device). */
export interface RackMountInfo {
  ears: boolean
  /** The position fitted; "" without ears. */
  position: EarPosition | ""
  /** Faceplate in front of the ear plane, mm. */
  offset_mm: number
  /** The model's origin (front of its ears in the front position, spec
   * §3) in front of the rail plane, mm: this position's offset less the
   * front one's. 0 without ears. */
  shift_mm: number
  rails: RailKind
  /** Turned round in its U (the `reversed` position): its rear face is
   * `offset_mm` in front of the ear plane. Optional for older payloads. */
  reversed?: boolean
  /** The ear plate's thickness (mm). Optional for older payloads. */
  ear_mm?: number
}

export const EAR_POSITIONS: EarPosition[] = ["front", "mid", "rear", "reversed"]

export const EAR_POSITION_LABELS: Record<EarPosition, string> = {
  front: "Front",
  mid: "Mid",
  rear: "Rear",
  reversed: "Reversed",
}

/** The positions a type offers, in order (front only when not recorded;
 * none without ears). */
export function earPositions(
  block: RackMountBlock | null | undefined
): EarPosition[] {
  if (!block) return ["front"]
  if (!block.ears) return []
  return EAR_POSITIONS.filter((p) => block.positions[p] !== undefined)
}

/** A device's mount, as api.rack_mount.mount_of works it out: its own ear
 * position if the type offers it, else the type's default, else the first. */
export function rackMountOf(
  block: RackMountBlock | null | undefined,
  earPosition: string = ""
): RackMountInfo {
  const none = { offset_mm: 0, shift_mm: 0, reversed: false }
  const plate = { ear_mm: block?.ear_mm ?? EAR_PLATE_MM }
  if (!block)
    return { ears: true, position: "front", ...none, rails: "none", ...plate }
  if (!block.ears)
    return { ears: false, position: "", ...none, rails: block.rails, ear_mm: 0 }
  const offered = earPositions(block)
  if (offered.length === 0)
    return { ears: true, position: "front", ...none, rails: block.rails, ...plate }
  const pos = (offered as string[]).includes(earPosition)
    ? (earPosition as EarPosition)
    : block.default && offered.includes(block.default)
      ? block.default
      : offered[0]
  const offset = block.positions[pos] ?? 0
  const reversed = pos === "reversed"
  return {
    ears: true,
    position: pos,
    offset_mm: offset,
    shift_mm: reversed ? 0 : offset - (block.positions.front ?? 0),
    rails: block.rails,
    reversed,
    ...plate,
  }
}

/** The faceplate's distance in front of the ear plane (m, + toward the
 * rack front); 0 for an earless device, whose faceplate is the rail plane. */
export function faceplateOffsetM(
  info: RackMountInfo | null | undefined
): number {
  return info && info.ears ? info.offset_mm / 1000 : 0
}

/**
 * How far a racked device's model moves in front of the rail plane (m):
 * its origin is the front of its ears in the front position (spec §3).
 */
export function modelShiftM(info: RackMountInfo | null | undefined): number {
  return info && info.ears ? info.shift_mm / 1000 : 0
}

/** A rack ear's plate thickness (mm), unless the type gives its own
 * (`ear_mm`). A model's origin is the front of its ears (spec §3), so the
 * plate's back - what bolts onto the rail - stands this far behind it: the
 * model sits this much further forward. */
export const EAR_PLATE_MM = 2
/** The plate thicknesses a type may give (mm). */
export const EAR_MM_MIN = 0.5
export const EAR_MM_MAX = 10

/** How far a device with ears stands forward of where its ears' front
 * would put it (m): the plate, so its back is on the rail - the type's
 * `ear_mm`, else `EAR_PLATE_MM`. An unrecorded type has ears; an earless
 * device's faceplate is on the rail itself. */
export function earPlateM(info: RackMountInfo | null | undefined): number {
  if (!(info?.ears ?? true)) return 0
  const t = info?.ear_mm
  return (typeof t === "number" && t > 0 ? t : EAR_PLATE_MM) / 1000
}

/** Whether a device is turned round in its U (the `reversed` fitting):
 * its rear panel faces the way its face would. */
export function isReversed(info: RackMountInfo | null | undefined): boolean {
  return !!(info && info.ears && info.reversed)
}

/**
 * How far a fitted model's front - the most forward point of its box: the
 * faceplate, or the ears where they stand ahead of it (a recessed front
 * fitting) - stands in front of the rail plane (m). The fit centres the
 * model on its box, so this is where the box goes for its origin (the
 * front ears) to land `modelShiftM` in front of the rail, the ears' plate
 * on the rail's face (`earPlateM`). 0 without ears.
 */
export function modelFrontM(info: RackMountInfo | null | undefined): number {
  // Reversed: the most forward point is the rear face, at its offset.
  const out =
    info && info.ears
      ? info.reversed
        ? info.offset_mm
        : Math.max(info.shift_mm, info.offset_mm)
      : 0
  return out / 1000 + earPlateM(info)
}

/** Whether a device has rack ears (an unrecorded type does). */
export function hasEars(info: RackMountInfo | null | undefined): boolean {
  return info?.ears ?? true
}

/** Why `block` (a form's) can't be saved, or null - the API's rules. */
export function rackMountError(block: RackMountBlock): string | null {
  if (!block.ears) return null
  const offered = earPositions(block)
  if (offered.length === 0) return "Give at least one ear position."
  if (block.default && !offered.includes(block.default))
    return "The default must be one of its positions."
  for (const p of offered) {
    const v = block.positions[p]!
    if (!Number.isFinite(v) || Math.abs(v) > 2000)
      return `${EAR_POSITION_LABELS[p]}: a distance within ±2000 mm.`
  }
  const t = block.ear_mm
  if (t !== undefined && (!Number.isFinite(t) || t < EAR_MM_MIN || t > EAR_MM_MAX))
    return `Ear plate: ${EAR_MM_MIN}-${EAR_MM_MAX} mm.`
  return null
}

/** A form's rack-mount state: mm as text, "" for a position not offered. */
export interface RackMountDraft {
  ears: boolean
  front: string
  mid: string
  rear: string
  reversed: string
  default: EarPosition | ""
  rails: RailKind
  /** Ear plate thickness, mm; "" for the default. */
  ear_mm: string
}

export function rackMountDraft(
  block: RackMountBlock | null | undefined
): RackMountDraft {
  const t = (v: number | undefined) => (v === undefined ? "" : String(v))
  return {
    ears: block?.ears ?? true,
    front: t(block?.positions.front),
    mid: t(block?.positions.mid),
    rear: t(block?.positions.rear),
    reversed: t(block?.positions.reversed),
    default: block?.default ?? "",
    rails: block?.rails ?? "none",
    ear_mm: t(block?.ear_mm),
  }
}

/** The block a draft saves: null when nothing is recorded (ears in front,
 * flush - the default every type had). */
export function rackMountPayload(d: RackMountDraft): RackMountBlock | null {
  const positions: Partial<Record<EarPosition, number>> = {}
  if (d.ears)
    for (const p of EAR_POSITIONS) {
      const v = d[p].trim()
      if (v !== "") positions[p] = Number(v)
    }
  const ear = d.ears ? d.ear_mm.trim() : ""
  if (
    d.ears &&
    Object.keys(positions).length === 0 &&
    d.rails === "none" &&
    ear === ""
  )
    return null
  return {
    ears: d.ears,
    positions,
    default: d.ears ? d.default : "",
    rails: d.rails,
    ...(ear !== "" ? { ear_mm: Number(ear) } : {}),
  }
}

/** A type's mounting in a line: "Front 0 · Mid 220 mm, sliding rails". */
export function rackMountSummary(
  block: RackMountBlock | null | undefined
): string {
  if (!block) return "Front ears"
  const rails = block.rails !== "none" ? `${block.rails} rails` : ""
  if (!block.ears) return ["No ears", rails].filter(Boolean).join(", ")
  const pos = earPositions(block)
    .map((p) => {
      const v = block.positions[p]!
      const s = `${EAR_POSITION_LABELS[p]} ${v} mm`
      return p === block.default ? `${s} (default)` : s
    })
    .join(" · ")
  const plate = block.ear_mm != null ? `${block.ear_mm} mm ears` : ""
  return [pos, plate, rails].filter(Boolean).join(", ")
}
