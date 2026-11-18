/**
 * How a device sits on a rack's rails (api.rack_mount, the export spec §3
 * and §8 "Rack mounting"). A device type's `rack_mount` block gives its
 * ear positions - where the faceplate stands in front of the ear plane, mm,
 * + toward the rack front - and a device picks one (`ear_position`, blank
 * for the type's default).
 */

export type EarPosition = "front" | "mid" | "rear"
export type RailKind = "none" | "fixed" | "sliding"

/** A device type's stored `rack_mount` block. Null: not recorded. */
export interface RackMountBlock {
  ears: boolean
  positions: Partial<Record<EarPosition, number>>
  default: EarPosition | ""
  rails: RailKind
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
}

export const EAR_POSITIONS: EarPosition[] = ["front", "mid", "rear"]

export const EAR_POSITION_LABELS: Record<EarPosition, string> = {
  front: "Front",
  mid: "Mid",
  rear: "Rear",
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
  const none = { offset_mm: 0, shift_mm: 0 }
  if (!block) return { ears: true, position: "front", ...none, rails: "none" }
  if (!block.ears)
    return { ears: false, position: "", ...none, rails: block.rails }
  const offered = earPositions(block)
  if (offered.length === 0)
    return { ears: true, position: "front", ...none, rails: block.rails }
  const pos = (offered as string[]).includes(earPosition)
    ? (earPosition as EarPosition)
    : block.default && offered.includes(block.default)
      ? block.default
      : offered[0]
  const offset = block.positions[pos] ?? 0
  return {
    ears: true,
    position: pos,
    offset_mm: offset,
    shift_mm: offset - (block.positions.front ?? 0),
    rails: block.rails,
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

/**
 * How far a fitted model's front - the most forward point of its box: the
 * faceplate, or the ears where they stand ahead of it (a recessed front
 * fitting) - stands in front of the rail plane (m). The fit centres the
 * model on its box, so this is where the box goes for its origin (the
 * front ears) to land `modelShiftM` in front of the rail. 0 without ears.
 */
export function modelFrontM(info: RackMountInfo | null | undefined): number {
  return info && info.ears ? Math.max(info.shift_mm, info.offset_mm) / 1000 : 0
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
  return null
}

/** A form's rack-mount state: mm as text, "" for a position not offered. */
export interface RackMountDraft {
  ears: boolean
  front: string
  mid: string
  rear: string
  default: EarPosition | ""
  rails: RailKind
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
    default: block?.default ?? "",
    rails: block?.rails ?? "none",
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
  if (d.ears && Object.keys(positions).length === 0 && d.rails === "none")
    return null
  return {
    ears: d.ears,
    positions,
    default: d.ears ? d.default : "",
    rails: d.rails,
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
  return [pos, rails].filter(Boolean).join(", ")
}
