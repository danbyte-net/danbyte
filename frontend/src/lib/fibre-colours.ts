/**
 * The colours Danbyte gives a fibre cord's recoloured materials (export
 * spec §13 v1.9, docs/dcim/model-packs.md → Colours), by the TIA-598 jacket
 * and connector conventions:
 *
 * - `FIBRE` (the jackets): the cable's own colour when it has one, else by
 *   its type - OS1/OS2 yellow, OM1/OM2 orange, OM3/OM4 aqua, OM5 lime.
 * - `LC_BODY` (the connector bodies and duplex clip): by type - single-mode
 *   UPC blue, APC green, OM1/OM2 beige, OM3/OM4 aqua, OM5 lime.
 *
 * Pure: the viewer's cords (floorplan3d/port-plugs) and the room's cable
 * runs (floorplan3d/cable-trace-3d) both read it.
 */

/** A part's cable-coloured material with no cable colour or type: a
 * neutral patch-cord grey. */
export const NEUTRAL = "#9ca3af"

export const FIBRE_COLOURS = {
  yellow: "#f2c318",
  orange: "#ee7d22",
  aqua: "#1fb8c9",
  lime: "#9acd32",
  beige: "#d8c8a6",
  blue: "#2463c7",
  green: "#2f9e52",
} as const

const HEX = /^#[0-9a-f]{6}$/i

/** The fibre grade a cable type names: `os` (single-mode), `om12`,
 * `om34`, `om5`, or null for a type that is no fibre or says no grade. */
export function fibreGrade(
  cableType: string | null | undefined
): "os" | "om12" | "om34" | "om5" | null {
  const t = (cableType ?? "").trim().toLowerCase()
  if (!t) return null
  if (t.startsWith("smf") || /\bos[12]\b/.test(t)) return "os"
  const om = /om([1-5])/.exec(t)
  if (om) return om[1] === "5" ? "om5" : om[1] <= "2" ? "om12" : "om34"
  // Plain multimode: the legacy grade's colours.
  if (t.startsWith("mmf")) return "om12"
  // An active optical cable's jacket is aqua (OM3-class fibre).
  if (t.startsWith("aoc")) return "om34"
  return null
}

/** The `FIBRE` jacket colour: the cable's own, else its type's. */
export function fibreColor(
  cableColor: string | null | undefined,
  cableType: string | null | undefined
): string {
  if (cableColor && HEX.test(cableColor)) return cableColor.toLowerCase()
  switch (fibreGrade(cableType)) {
    case "os":
      return FIBRE_COLOURS.yellow
    case "om12":
      return FIBRE_COLOURS.orange
    case "om34":
      return FIBRE_COLOURS.aqua
    case "om5":
      return FIBRE_COLOURS.lime
    default:
      return NEUTRAL
  }
}

/** Whether a connector is angle-polished: an `-apc` port or front-port
 * type (`lc-apc-duplex`) or connector (`lc-apc`). */
export function isApc(...names: (string | null | undefined)[]): boolean {
  return names.some((n) => /(^|-)apc(-|$)/i.test((n ?? "").trim()))
}

/** The `LC_BODY` colour: by the fibre grade, single-mode by its polish. */
export function lcBodyColor(
  cableType: string | null | undefined,
  apc: boolean
): string {
  switch (fibreGrade(cableType)) {
    case "os":
      return apc ? FIBRE_COLOURS.green : FIBRE_COLOURS.blue
    case "om12":
      return FIBRE_COLOURS.beige
    case "om34":
      return FIBRE_COLOURS.aqua
    case "om5":
      return FIBRE_COLOURS.lime
    default:
      // An APC end is single-mode whatever the cable says.
      return apc ? FIBRE_COLOURS.green : NEUTRAL
  }
}

/** The `CABLE` colour of a copper cord, power cord or DAC: the cable's
 * own, else grey. */
export function copperColor(cableColor: string | null | undefined): string {
  return cableColor && HEX.test(cableColor) ? cableColor.toLowerCase() : NEUTRAL
}

/** Which colour a material name takes, or null when it keeps its own. */
export type RecolourChannel = "cable" | "fibre" | "lc"

export function recolourChannel(materialName: string): RecolourChannel | null {
  switch (materialName) {
    case "CABLE":
      return "cable"
    case "FIBRE":
      return "fibre"
    case "LC_BODY":
      return "lc"
    default:
      return null
  }
}

/** The three recolour channels' colours for one cabled end. */
export function endColours(end: {
  color: string | null | undefined
  cableType: string | null | undefined
  apc: boolean
}): Record<RecolourChannel, string> {
  return {
    cable: copperColor(end.color),
    fibre: fibreColor(end.color, end.cableType),
    lc: lcBodyColor(end.cableType, end.apc),
  }
}
