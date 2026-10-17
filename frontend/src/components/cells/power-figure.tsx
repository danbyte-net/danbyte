import { CapacityBar } from "@/components/cells/capacity-bar"
import { dash } from "@/components/cells/dash"
import {
  formatWatts,
  hasPowerData,
  powerSupplyNote,
  rackPowerDemand,
  rackPowerRatio,
} from "@/lib/rack-capacity"
import type { RackPower } from "@/lib/rack-capacity"
import { cn } from "@/lib/utils"

/**
 * A rack's power as one figure, the same everywhere it shows: **demand /
 * supply** ("1.2 kW / 3.6 kW"). Demand is the allocated draw where recorded,
 * else the nameplate sum, marked *nameplate*; supply is the rack's power
 * budget when set, marked *budget*, else its primary feeds, else its PDUs'
 * inlet rating, marked *PDU rating*, and a rack drawing power with none of
 * them says *No feed*. Demand above supply turns the figure red.
 *
 * `bar` puts the capacity bar in front, coloured by the tenant's capacity
 * levels - for table cells and popovers. Nothing to say renders a dash.
 */
export function PowerFigure({
  power,
  bar = false,
  barClassName,
  className,
}: {
  power: RackPower | null | undefined
  /** Lead with the capacity bar. */
  bar?: boolean
  /** The bar's size, when the slot is narrower than a table cell. */
  barClassName?: string
  className?: string
}) {
  if (!hasPowerData(power)) return dash
  const demand = rackPowerDemand(power)
  const supply = power.available_w
  const ratio = rackPowerRatio(power)
  const over = ratio != null && ratio > 1
  const note = [
    demand.nameplate && "nameplate",
    powerSupplyNote(power),
    supply <= 0 && "No feed",
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <span
      data-slot="power-figure"
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap",
        className
      )}
    >
      {bar && <CapacityBar ratio={ratio} className={barClassName} />}
      <span
        className={cn(
          "num",
          bar && "text-[11px] text-muted-foreground",
          over && "font-medium text-destructive"
        )}
      >
        {formatWatts(demand.watts)}
        {supply > 0 && ` / ${formatWatts(supply)}`}
      </span>
      {note && (
        <span className="-ml-1 text-[11px] text-muted-foreground">{note}</span>
      )}
    </span>
  )
}
