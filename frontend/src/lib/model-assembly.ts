import type { ModelBay, ModelEmptyMode } from "@/lib/api"

/**
 * Modular 3D models (docs/dcim/model-packs.md): a chassis model names its
 * module bays, their empty covers, ports and LEDs; each module type has its
 * own model, posed at the chassis' `bay:<name>` node. These are the pure
 * decisions - which part goes where, which covers show, what a module's
 * node names become in a bay - with no three.js, so they test without a
 * canvas. floorplan3d/model-assembly applies them to the loaded scenes.
 *
 * Names are the glTF node names, exactly as authored. three.js rewrites
 * `object.name` (`bay:FAN 1` → `bayFAN_1`), so the loader keeps the real
 * name in `userData.gltfName` (floorplan3d/device-model).
 */

export type AnchorKind = "bay" | "empty" | "port" | "led"

const PREFIXES: readonly AnchorKind[] = ["bay", "empty", "port", "led"]

/** `bay:PS-0` → `{kind: "bay", name: "PS-0"}`; null for any other name. */
export function parseAnchor(
  gltfName: string | null | undefined
): { kind: AnchorKind; name: string } | null {
  if (!gltfName) return null
  const i = gltfName.indexOf(":")
  if (i <= 0) return null
  const kind = gltfName.slice(0, i) as AnchorKind
  const name = gltfName.slice(i + 1)
  if (!PREFIXES.includes(kind) || !name) return null
  return { kind, name }
}

/** A module's node name as it lands in a bay: `{module}` becomes the
 * bay's position, as the server names the installed interfaces
 * (api.models.render_module_name). An empty position leaves it as is. */
export function substituteModule(name: string, position: string): string {
  if (!position) return name
  return name.split("{module}").join(position)
}

/** One installed part to pose: the bay it goes in and its model URL. */
export interface PlannedPart {
  bay: string
  position: string
  url: string
}

/**
 * The parts a device draws: each bay with an installed module whose type
 * has a model, and whose `bay:` node the chassis has. `far` picks each
 * part's far copy where it has one.
 */
export function plannedParts(
  bays: readonly ModelBay[] | null | undefined,
  chassisBays: ReadonlySet<string>,
  far = false
): PlannedPart[] {
  const out: PlannedPart[] = []
  for (const b of bays ?? []) {
    if (!b.part || !chassisBays.has(b.name)) continue
    out.push({
      bay: b.name,
      position: b.position,
      url: (far && b.part.far_url) || b.part.url,
    })
  }
  return out
}

/**
 * Whether each `empty:<name>` cover in the chassis shows.
 *
 * - No bay list (a type's own viewer, or a device whose model names no
 *   bays): the model as authored - every cover shows.
 * - `empty_mode: "nothing"`: none.
 * - Otherwise a cover shows while its bay is the device's and has no part
 *   drawn in it: empty, or a module whose model hasn't loaded or doesn't
 *   exist (the cover stands in rather than leaving a hole). A cover for a
 *   bay the device doesn't have hides.
 */
export function coverVisibility(
  covers: readonly string[],
  bays: readonly ModelBay[] | null | undefined,
  drawn: ReadonlySet<string>,
  mode: ModelEmptyMode = "filler"
): Map<string, boolean> {
  const out = new Map<string, boolean>()
  const known = bays ? new Set(bays.map((b) => b.name)) : null
  for (const c of covers) {
    if (known === null) out.set(c, true)
    else if (mode === "nothing") out.set(c, false)
    else out.set(c, known.has(c) && !drawn.has(c))
  }
  return out
}

/** Triangles a device costs: its chassis plus every part drawn in it. */
export function assemblyTriangles(
  chassis: number,
  parts: readonly number[]
): number {
  return parts.reduce((a, b) => a + b, chassis)
}

/** What a device draws within the room's triangle budget: the assembled
 * model, else the chassis alone, else its box. `left` is what the room has
 * left; `limit` the cap on one model. */
export function budgetLevel(
  chassis: number,
  parts: readonly number[],
  left: number,
  limit: number
): "assembled" | "chassis" | "box" {
  const all = assemblyTriangles(chassis, parts)
  if (all <= limit && all <= left) return "assembled"
  if (chassis <= limit && chassis <= left) return "chassis"
  return "box"
}

/** Far-model switch distances (m) with a gap, so a device at the edge
 * doesn't flicker between its two models. */
export const FAR_MODEL_AT_M = 14
export const NEAR_MODEL_AT_M = 11

export function wantsFarModel(dist: number, far: boolean): boolean {
  return far ? dist > NEAR_MODEL_AT_M : dist > FAR_MODEL_AT_M
}
