import type { CheckStatus } from "@/lib/api"
import { STATUS_COLOR, STATUS_LABEL } from "./charts"
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
  const entries = ORDER.map((s) => [s, counts?.[s] ?? 0] as const).filter(
    ([, n]) => n > 0
  )
  const total = entries.reduce((a, [, n]) => a + n, 0)

  if (total === 0) {
    return status ? (
      <CheckStatusBadge status={status} />
    ) : (
      <span className="text-muted-foreground">—</span>
    )
  }
  if (entries.length === 1) {
    return <CheckStatusBadge status={entries[0][0]} />
  }

  // Equal bands per distinct status (50/50 for two, thirds for three, …) — the
  // badge shows *which* statuses are present, not the ratio. Angled hard stops
  // make them diagonal triangles like a racing flag.
  const slice = 100 / entries.length
  const stops = entries
    .map(([s], i) => `${STATUS_COLOR[s]} ${i * slice}% ${(i + 1) * slice}%`)
    .join(", ")
  const title = entries.map(([s, n]) => `${n} ${STATUS_LABEL[s]}`).join(" · ")

  return (
    <span
      title={title}
      aria-label={title}
      className="inline-block h-5 w-8 rounded-[5px] align-middle ring-1 ring-black/10 ring-inset dark:ring-white/15"
      style={{ backgroundImage: `linear-gradient(to top right, ${stops})` }}
    />
  )
}
