import type { CoolingFeedFlow } from "@/lib/api"
import { CapacityBar } from "@/components/cells/capacity-bar"
import { dash } from "@/components/cells/dash"
import { cn } from "@/lib/utils"

const fmt = (n: number) => `${Number(n.toFixed(1))}`

/** A cooling feed's flow (#434): the summed max flow of the intakes on it
 * against its own flow rate - "30 / 50 L/min" behind the capacity bar, red
 * when over. Only the feed's rate, plain, when no intake gives a flow. */
export function FlowFigure({ flow }: { flow: CoolingFeedFlow | undefined }) {
  if (!flow) return dash
  const { connected_lpm: used, rated_lpm: rated } = flow
  if (used == null)
    return rated == null ? (
      dash
    ) : (
      <span className="num">{fmt(rated)} L/min</span>
    )
  const ratio = rated ? used / rated : null
  const over = ratio != null && ratio > 1
  return (
    <span
      data-slot="flow-figure"
      className="inline-flex items-center gap-2 whitespace-nowrap"
    >
      <CapacityBar ratio={ratio} />
      <span
        className={cn(
          "num text-[11px] text-muted-foreground",
          over && "font-medium text-destructive"
        )}
      >
        {fmt(used)}
        {rated != null && ` / ${fmt(rated)}`} L/min
      </span>
    </span>
  )
}
