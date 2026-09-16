import type { CheckStatus } from "@/lib/api"
import {
  statusColor,
  statusLabel,
  useStatusLabels,
} from "./status-palette"
import { CheckStatusBadge } from "./status-badge"

// Left→right best→worst, so a green/red split reads "good on the left, bad on
// the right" like the user's racing-flag idea.
const ORDER: CheckStatus[] = [
  "up",
  "skipped",
  "unknown",
  "degraded",
  "stale",
  "down",
]

/**
 * A mixed-status "racing flag": a badge-sized pill split by an angled diagonal
 * into colour bands sized by how many checks are in each status. With a single
 * status it's just the normal badge. Hover shows the breakdown.
 */
export function MixedStatusBadge({
  counts,
  status,
}: {
  counts?: Partial<Record<CheckStatus, number>>
  status?: CheckStatus | null
}) {
  const labels = useStatusLabels()
  const entries = ORDER.map((s) => [s, counts?.[s] ?? 0] as const).filter(
    ([, n]) => n > 0
  )
  const total = entries.reduce((a, [, n]) => a + n, 0)

  if (total === 0) {
    return status ? (
      <CheckStatusBadge status={status} />
    ) : (
      <span className="text-muted-foreground">-</span>
    )
  }
  if (entries.length === 1) {
    return <CheckStatusBadge status={entries[0][0]} />
  }

  // Equal bands per distinct status (50/50 for two, thirds for three, …) - the
  // badge shows *which* statuses are present, not the ratio. Angled hard stops
  // make them diagonal triangles like a racing flag.
  const slice = 100 / entries.length
  const stops = entries
    .map(([s], i) => `${statusColor(s, labels)} ${i * slice}% ${(i + 1) * slice}%`)
    .join(", ")
  const breakdown = entries
    .map(([s, n]) => `${n} ${statusLabel(s, labels)}`)
    .join(" · ")

  // The bands are the visual; the breakdown is the text. Every cell that
  // renders this wraps it in the shared hover, so no tooltip of its own.
  return (
    <span className="inline-flex items-center">
      <span
        aria-hidden
        className="inline-block h-5 w-8 rounded-[5px] align-middle ring-1 ring-black/10 ring-inset dark:ring-white/15"
        style={{ backgroundImage: `linear-gradient(to top right, ${stops})` }}
      />
      <span className="sr-only">{breakdown}</span>
    </span>
  )
}
