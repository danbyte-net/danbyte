import type { BulkStatusEntry } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { FlappingPill } from "./flapping-pill"

/**
 * What a status alone cannot say: that a check is flapping, how many
 * problems an external system has open, and which protocols it cannot reach
 * the target on. Chips beside the roll-up badge; the hover on the whole cell
 * (ExternalStatusHover) carries the detail, so these stay small.
 *
 * Each chip carries its meaning as text for a reader that cannot see the
 * tint - "3" on its own is not a fact.
 */
export function ExternalChips({ entry }: { entry?: BulkStatusEntry | null }) {
  const problems = entry?.problems ?? 0
  const unreachable = entry?.unreachable ?? []
  const flapping = entry?.flapping ?? 0
  if (!problems && unreachable.length === 0 && !flapping) return null

  return (
    <span className="inline-flex items-center gap-1">
      {/* Danbyte's own flag rides in the same row as the external ones: a
          chip beside the badge is where "there is more to this status"
          lives, whoever noticed it. */}
      {flapping > 0 && <FlappingPill count={flapping} />}
      {problems > 0 && (
        <Badge variant="warning" className="num">
          {problems}
          <span className="sr-only">
            {problems === 1 ? " open problem" : " open problems"}
          </span>
        </Badge>
      )}
      {unreachable.map((proto) => (
        <Badge key={proto} variant="destructive" className="uppercase">
          {proto}
          <span className="sr-only"> unreachable</span>
        </Badge>
      ))}
    </span>
  )
}
