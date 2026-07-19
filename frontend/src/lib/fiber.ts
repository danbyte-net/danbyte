// Fibre-strand colour derivation — the frontend twin of api/fiber_colors.py.
// The 12-colour TIA-598-C sequence is the default; a tenant can reorder/recolour
// it on the Fibre settings page (GET/POST /api/fiber-settings/). Beyond 12 the
// sequence repeats and the repeat *group* is shown as a black tracer: a stripe
// on the 2nd dozen, an added ring on each further dozen.
// See docs/architecture/fiber-strands.md.

export interface FiberColorEntry {
  name: string
  hex: string
}

// TIA-598-C, positions 1..12. Keep in sync with api/fiber_colors.py.
export const TIA_598C: FiberColorEntry[] = [
  { name: "Blue", hex: "#0071CE" },
  { name: "Orange", hex: "#FF7A00" },
  { name: "Green", hex: "#00A651" },
  { name: "Brown", hex: "#7B4A12" },
  { name: "Slate", hex: "#8A8D8F" },
  { name: "White", hex: "#F4F4F4" },
  { name: "Red", hex: "#E4002B" },
  { name: "Black", hex: "#101010" },
  { name: "Yellow", hex: "#FFD100" },
  { name: "Violet", hex: "#8246AF" },
  { name: "Rose", hex: "#F4A6C0" },
  { name: "Aqua", hex: "#00B5C7" },
]

export interface FiberStrandColor {
  position: number
  name: string
  hex: string
  /** Which dozen: 0 = 1–12, 1 = 13–24, … */
  group: number
  /** Black tracer stripe (2nd dozen onward). */
  stripe: boolean
  /** Extra black rings (25–36 = 1, 37–48 = 2, …). */
  rings: number
}

/** Colour + tracer marks for a 1-based strand `position`. */
export function fiberColor(
  position: number,
  palette: FiberColorEntry[] = TIA_598C
): FiberStrandColor {
  const pal = palette.length ? palette : TIA_598C
  const n = pal.length
  // Guard against a 0/negative/NaN position: a bare `% n` can go negative (or
  // NaN) and index off the end → `base` undefined → "reading 'hex' of
  // undefined". Normalise into [0, n) and fall back to the first entry.
  const safePos = Number.isFinite(position) ? position : 1
  const idx = (((safePos - 1) % n) + n) % n
  const group = Math.max(0, Math.floor((safePos - 1) / n))
  const base = pal[idx] ?? pal[0]
  return {
    position,
    name: base.name,
    hex: base.hex,
    group,
    stripe: group >= 1,
    rings: Math.max(0, group - 1),
  }
}

/** Cable `type` values that are optical fibre (offer strands). */
export function isFiberType(type: string | null | undefined): boolean {
  return !!type && (type.startsWith("smf") || type.startsWith("mmf"))
}

/** Black or white foreground for a hex fill (Rec. 709 luminance). */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "#fff"
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return L > 0.6 ? "#0a0a0a" : "#fff"
}
