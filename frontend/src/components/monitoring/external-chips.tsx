import type { BulkStatusEntry } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/**
 * What an external monitoring system knows that Danbyte's own status cannot
 * say: how many problems are open, and which protocols it cannot reach the
 * target on. Chips beside the roll-up badge; the hover on the whole cell
 * (ExternalStatusHover) carries the detail, so these stay small.
 *
 * Each chip carries its meaning as text for a reader that cannot see the
 * tint - "3" on its own is not a fact.
 */
export function ExternalChips({ entry }: { entry?: BulkStatusEntry | null }) {
  const problems = entry?.problems ?? 0
  const unreachable = entry?.unreachable ?? []
  if (!problems && unreachable.length === 0) return null

  return (
    <span className="inline-flex items-center gap-1">
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
