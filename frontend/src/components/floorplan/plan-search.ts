import type {
  FloorPlanCablePath,
  FloorPlanCableEnd,
  FloorPlanCableFar,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import { searchTiles } from "./selection"
import { areaName } from "./shapes"
import type { AreaShape, PlanShape } from "./shapes"
import { tileOpen } from "./tile-open"

/** One hit of "Find on plan…": an object (tile), a cable, a tray or an
 * area. */
export type PlanHit =
  | { kind: "object"; id: string; tile: FloorPlanTile }
  | { kind: "cable"; id: string; cable: FloorPlanCablePath; match: string }
  | { kind: "tray"; id: string; tray: FloorPlanTray }
  | { kind: "area"; id: string; area: AreaShape }

export const HIT_GROUPS: { kind: PlanHit["kind"]; label: string }[] = [
  { kind: "object", label: "Objects" },
  { kind: "cable", label: "Cables" },
  { kind: "tray", label: "Trays" },
  { kind: "area", label: "Areas" },
]

/** The most hits one group lists. */
export const GROUP_LIMIT = 8

const wordsOf = (q: string) =>
  q.trim().toLowerCase().split(/\s+/).filter(Boolean)

const hasAll = (words: string[], s: string | null | undefined) =>
  !!s && words.every((w) => s.toLowerCase().includes(w))

/** Each end of a cable as `device port`, Hidden ends left out. */
export function cableEndTexts(cp: FloorPlanCablePath): string[] {
  const ends: (FloorPlanCableEnd | FloorPlanCableFar)[] = [
    ...cp.a_points,
    ...(cp.a_far ?? []),
    ...cp.b_points,
    ...(cp.b_far ?? []),
  ]
  return ends.flatMap((e) =>
    e.hidden ? [] : [[e.device_name, e.port].filter(Boolean).join(" ")]
  )
}

/** Cables matching every word: by label or id first, then by one end's
 * device and port ("sw1 Gi1/0/1"). `match` names what matched. */
export function searchCables(
  cables: readonly FloorPlanCablePath[],
  query: string,
  limit = GROUP_LIMIT
): Extract<PlanHit, { kind: "cable" }>[] {
  const words = wordsOf(query)
  if (!words.length) return []
  const ranked: { hit: Extract<PlanHit, { kind: "cable" }>; rank: number }[] =
    []
  for (const cp of cables) {
    let rank = -1
    let match = ""
    if (hasAll(words, cp.label)) rank = 0
    else if (words.length === 1 && cp.id.toLowerCase().startsWith(words[0]))
      rank = 1
    else {
      const end = cableEndTexts(cp).find((t) => hasAll(words, t))
      if (end) {
        rank = 2
        match = end
      }
    }
    if (rank >= 0)
      ranked.push({ hit: { kind: "cable", id: cp.id, cable: cp, match }, rank })
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.hit)
}

/** What the editor does with a pick. */
export interface PickActions {
  /** Trace the cable, open its panel and frame its route. */
  openCable: (cableId: string, fit: true) => void
  /** Light the tray and frame it. */
  highlightTray: (trayId: string) => void
  /** Select or open the area and frame it. */
  showArea: (area: AreaShape) => void
  /** Select and frame the tile (fly to it in 3D). */
  showTile: (tile: FloorPlanTile) => void
  /** Open a device, rack or cabinet tile's panel. */
  openTilePanel: (tile: FloorPlanTile) => void
  /** Pin the popover of a tile without a panel (power, cooling…). */
  pinTile: (tile: FloorPlanTile) => void
}

/** A pick from "Find on plan…": a cable traces, frames and opens its
 * panel; a tray lights; an area or object is framed - and a device,
 * rack or cabinet opens its panel while viewing. */
export function applyPick(
  h: PlanHit,
  act: PickActions,
  { editing }: { editing: boolean }
): void {
  switch (h.kind) {
    case "cable":
      act.openCable(h.id, true)
      return
    case "tray":
      act.highlightTray(h.id)
      return
    case "area":
      act.showArea(h.area)
      return
    case "object": {
      act.showTile(h.tile)
      if (editing) return
      // Viewing, a pick opens the object the way a click on it does: its
      // panel, or its pinned popover for the kinds without one.
      if (tileOpen(h.tile).kind === "panel") act.openTilePanel(h.tile)
      else act.pinTile(h.tile)
    }
  }
}

/** Everything on the plan matching `query`, grouped in HIT_GROUPS order. */
export function searchPlan(
  {
    tiles,
    cables,
    trays,
    shapes,
  }: {
    tiles: readonly FloorPlanTile[]
    cables: readonly FloorPlanCablePath[]
    trays: readonly FloorPlanTray[]
    shapes: readonly PlanShape[]
  },
  query: string
): PlanHit[] {
  const words = wordsOf(query)
  if (!words.length) return []
  const objects: PlanHit[] = searchTiles(tiles, query, GROUP_LIMIT).map(
    (h) => ({ kind: "object", id: h.tile.id, tile: h.tile })
  )
  const trayHits: PlanHit[] = trays
    .filter((t) => hasAll(words, t.name))
    .slice(0, GROUP_LIMIT)
    .map((t) => ({ kind: "tray", id: t.id, tray: t }))
  const areaHits: PlanHit[] = shapes
    .filter((s): s is AreaShape => s.kind === "area")
    .filter((a) => hasAll(words, areaName(a)))
    .slice(0, GROUP_LIMIT)
    .map((a) => ({ kind: "area", id: a.id, area: a }))
  return [...objects, ...searchCables(cables, query), ...trayHits, ...areaHits]
}
