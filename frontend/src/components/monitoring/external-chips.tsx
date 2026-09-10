import type { BulkStatusEntry } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * What an external monitoring system knows that Danbyte's own status cannot
 * say: how many problems are open, and which protocols it cannot reach the
 * target on.
 *
 * Chips beside the roll-up badge rather than columns of their own. Both are
 * usually absent - only targets watched by something like Zabbix carry them -
 * and two permanently mostly-empty columns would cost every list page width it
 * has better uses for.
 *
 * "Unreachable on SNMP" is the important one. A host with no open problems
 * reads perfectly healthy while its SNMP interface has been polling nothing
 * for a week, because the community is wrong or missing.
 */
export function ExternalChips({ entry }: { entry?: BulkStatusEntry | null }) {
  const problems = entry?.problems ?? 0
  const unreachable = entry?.unreachable ?? []
  if (!problems && unreachable.length === 0) return null

  return (
    <span className="inline-flex items-center gap-1">
      {problems > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="warning" className="num">
              {problems}
            </Badge>
          </TooltipTrigger>
          <TooltipContent variant="panel">
            {problems === 1 ? "1 open problem" : `${problems} open problems`}
          </TooltipContent>
        </Tooltip>
      )}
      {unreachable.map((proto) => (
        <Tooltip key={proto}>
          <TooltipTrigger asChild>
            <Badge variant="destructive" className="uppercase">
              {proto}
            </Badge>
          </TooltipTrigger>
          <TooltipContent variant="panel">
            Not reachable on {proto.toUpperCase()} - the checks that use it are
            collecting nothing.
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}
