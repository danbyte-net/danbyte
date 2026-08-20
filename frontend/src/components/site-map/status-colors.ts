// Monitoring worst-status palette - THE single source. The full map, the
// MiniMap, the sidebars and the floor planner all read one of these two maps,
// so a "down" is the same red everywhere it appears. Leaflet-free on purpose:
// the sidebars import this without dragging the map bundle along.

/** Status → CSS color, for inline styles inside divIcon HTML. */
export const CHECK_COLOR: Record<string, string> = {
  up: "var(--color-emerald-500)",
  degraded: "var(--color-amber-500)",
  down: "var(--color-red-500)",
  stale: "var(--color-zinc-400)",
  unknown: "var(--color-zinc-400)",
}

/** Status → Tailwind background class, for React-rendered dots. */
export const CHECK_TONE: Record<string, string> = {
  up: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
  stale: "bg-zinc-400",
  unknown: "bg-zinc-400",
}

/** Severity order for roll-ups (worst first). */
const SEVERITY = ["down", "degraded", "stale", "up"] as const

export type MarkerKind = "site" | "device" | "marker"

// Z-tier table (issue #32): the selected marker always wins, then problems
// surface above healthy neighbours, then sites > free markers > devices.
// Leaflet's own latitude ordering breaks ties inside a tier. Lives here (not
// map-core) because this module stays leaflet-free and unit-testable.
export function markerZ(
  kind: MarkerKind,
  check: string | null | undefined,
  selected = false
): number {
  return (
    (selected ? 8000 : 0) +
    (check === "down" ? 4000 : check === "degraded" ? 3000 : 0) +
    (kind === "site" ? 2000 : kind === "marker" ? 1000 : 0)
  )
}

/** The worst status in a set, or null when nothing has one. */
export function worstCheck(checks: (string | null | undefined)[]): string | null {
  let worst: string | null = null
  let rank: number = SEVERITY.length
  for (const c of checks) {
    if (!c) continue
    const r = SEVERITY.indexOf(c as (typeof SEVERITY)[number])
    const effective = r === -1 ? SEVERITY.indexOf("stale") : r
    if (effective < rank) {
      rank = effective
      worst = c
    }
  }
  return worst
}
