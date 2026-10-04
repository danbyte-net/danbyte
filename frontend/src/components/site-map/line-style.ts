import type { SiteMapCapacity } from "@/lib/api"
import { naturalCompare } from "@/lib/natural-sort"
import { speedTier, SPEED_TIERS } from "@/lib/speed"
import type { SpeedTier } from "@/lib/speed"
import { cssColor } from "@/lib/utils"

// How the site map colours its lines - circuits, tunnels and cables - under
// the Display popover's Color by (#246). Leaflet-free, so the legend, the
// tests and both line layers read one rule.

/** The kinds of line, each in its own hue while colouring by type. */
export const KIND_COLOR: Record<string, string> = {
  circuit: "#0ea5e9", // sky
  tunnel: "#8b5cf6", // violet
  cable: "#f59e0b", // amber
}

/** Type: each kind's own colour, as the map has always drawn them. Status:
 * the line's status colour. Speed: the speed tier of its capacity, on the
 * scale the topology and the faceplates use. */
export type LineColorBy = "type" | "status" | "speed"

export const LINE_COLOR_BY: readonly { value: LineColorBy; label: string }[] = [
  { value: "type", label: "Type" },
  { value: "status", label: "Status" },
  { value: "speed", label: "Speed" },
]

export function isLineColorBy(v: unknown): v is LineColorBy {
  return v === "type" || v === "status" || v === "speed"
}

/** The zinc a line wears when the mode has nothing to say about it: no
 * status, or no known speed - never a guessed colour. */
export const NO_VALUE_HEX = "#71717a"

/** What the colour modes read off a line. A circuit or tunnel's `color` is
 * the server's pick (circuit type, else status); a cable's is its own. */
export interface LineLook {
  kind: string
  color?: string | null
  status?: { name: string; color: string } | null
  capacity?: Pick<SiteMapCapacity, "kbps"> | null
}

/** The speed tier a line's capacity falls in; null when no speed is known. */
export function lineTier(line: LineLook): SpeedTier | null {
  const kbps = line.capacity?.kbps
  return kbps && kbps > 0 ? speedTier(kbps / 1000) : null
}

/** The stroke a line gets under `by`. */
export function lineColor(line: LineLook, by: LineColorBy): string {
  if (by === "status") return cssColor(line.status?.color) ?? NO_VALUE_HEX
  if (by === "speed") return lineTier(line)?.hex ?? NO_VALUE_HEX
  const own = cssColor(line.color)
  if (own) return own
  return line.kind in KIND_COLOR ? KIND_COLOR[line.kind] : NO_VALUE_HEX
}

/** What the legend keys under Status and Speed: only what the drawn lines
 * carry. */
export interface LineKey {
  /** The statuses on the lines, by name. */
  statuses: { name: string; color: string }[]
  /** Some line has no status. */
  noStatus: boolean
  /** The speed tiers on the lines, slow to fast. */
  tiers: SpeedTier[]
  /** Some line has no known speed. */
  unknown: boolean
}

export function lineKey(lines: Iterable<LineLook>): LineKey {
  const statuses = new Map<string, string>()
  const tiers = new Set<string>()
  let noStatus = false
  let unknown = false
  for (const l of lines) {
    if (l.status?.name) {
      if (!statuses.has(l.status.name))
        statuses.set(l.status.name, l.status.color)
    } else noStatus = true
    const tier = lineTier(l)
    if (tier) tiers.add(tier.label)
    else unknown = true
  }
  return {
    statuses: [...statuses]
      .map(([name, color]) => ({ name, color }))
      .sort((a, b) => naturalCompare(a.name, b.name)),
    noStatus,
    tiers: SPEED_TIERS.filter((t) => tiers.has(t.label)),
    unknown,
  }
}
