import type { CheckStatus } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { statusColor, statusLabel, useStatusLabels } from "./status-palette"
import { CheckStatusBadge } from "./status-badge"

/** A state the badge can carry: a check state, or PRTG's paused. */
export type MixedState = CheckStatus | "paused"

// Left→right best→worst, so a green/red split reads "good on the left, bad on
// the right" like the user's racing-flag idea. Paused is nobody's verdict, so
// it sits at the quiet end.
const ORDER: MixedState[] = [
  "paused",
  "up",
  "skipped",
  "unknown",
  "degraded",
  "stale",
  "down",
]

/** Paused has no tenant colour: a neutral band, like the outline pill. */
const PAUSED_BAND = "var(--color-zinc-200)"

/** "Paused" for paused, the tenant's word for the rest. */
export function mixedStateLabel(
  s: MixedState,
  labels?: ReturnType<typeof useStatusLabels>
): string {
  return s === "paused" ? "Paused" : statusLabel(s, labels)
}

/** The states present in `counts`, best first, with their numbers. */
export function mixedEntries(
  counts?: Partial<Record<MixedState, number>>
): [MixedState, number][] {
  return ORDER.map((s) => [s, counts?.[s] ?? 0] as [MixedState, number]).filter(
    ([, n]) => n > 0
  )
}

/** One state as its pill: the shared check pill, or the outline Paused. */
export function StatePill({ state }: { state: MixedState }) {
  if (state === "paused") return <Badge variant="outline">Paused</Badge>
  return <CheckStatusBadge status={state} />
}

/**
 * A mixed-status "racing flag": a badge-sized pill split by an angled
 * diagonal into one band per state present. With a single state it is just
 * that state's pill ("Up"), never a count. The breakdown with numbers is the
 * hover's job - every caller wraps it in the shared one.
 */
export function MixedStatusBadge({
  counts,
  status,
}: {
  counts?: Partial<Record<MixedState, number>>
  status?: MixedState | null
}) {
  const labels = useStatusLabels()
  const entries = mixedEntries(counts)

  if (entries.length === 0) {
    return status ? (
      <StatePill state={status} />
    ) : (
      <span className="text-muted-foreground">-</span>
    )
  }
  if (entries.length === 1) {
    return <StatePill state={entries[0][0]} />
  }

  // Equal bands per distinct status (50/50 for two, thirds for three, …) - the
  // badge shows *which* statuses are present, not the ratio. Angled hard stops
  // make them diagonal triangles like a racing flag.
  const slice = 100 / entries.length
  const color = (s: MixedState) =>
    s === "paused" ? PAUSED_BAND : statusColor(s, labels)
  const stops = entries
    .map(([s], i) => `${color(s)} ${i * slice}% ${(i + 1) * slice}%`)
    .join(", ")
  const breakdown = entries
    .map(([s, n]) => `${n} ${mixedStateLabel(s, labels)}`)
    .join(" · ")

  return (
    <span className="inline-flex items-center" data-mixed="">
      <span
        aria-hidden
        className="inline-block h-5 w-8 rounded-[5px] align-middle ring-1 ring-black/10 ring-inset dark:ring-white/15"
        style={{ backgroundImage: `linear-gradient(to top right, ${stops})` }}
      />
      <span className="sr-only">{breakdown}</span>
    </span>
  )
}
