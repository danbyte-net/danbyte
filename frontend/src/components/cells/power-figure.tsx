import { CapacityBar } from "@/components/cells/capacity-bar"
import { dash } from "@/components/cells/dash"
import {
  formatWatts,
  hasCoolingData,
  hasPowerData,
  powerSupplyNote,
  rackCoolingDemand,
  rackCoolingRatio,
  rackPowerDemand,
  rackPowerRatio,
} from "@/lib/rack-capacity"
import type { RackCooling, RackPower } from "@/lib/rack-capacity"
import { cn } from "@/lib/utils"

interface FigureLook {
  /** Lead with the capacity bar. */
  bar?: boolean
  /** The bar's size, when the slot is narrower than a table cell. */
  barClassName?: string
  className?: string
}

/** What power and cooling share: **demand / supply** in watts, the notes
 * after it, red when demand is over supply, and the capacity bar in front
 * when asked for. */
function DemandFigure({
  slot,
  demand,
  nameplate,
  supply,
  supplyNote,
  missing,
  ratio,
  bar = false,
  barClassName,
  className,
}: FigureLook & {
  slot: string
  demand: number
  /** Demand is the nameplate sum, not recorded allocations. */
  nameplate: boolean
  supply: number
  /** Where the supply figure comes from, when that needs saying. */
  supplyNote: string
  /** What a figure without a supply says. */
  missing: string
  ratio: number | null
}) {
  const over = ratio != null && ratio > 1
  const note = [nameplate && "nameplate", supplyNote, supply <= 0 && missing]
    .filter(Boolean)
    .join(" · ")
  return (
    <span
      data-slot={slot}
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
        {formatWatts(demand)}
        {supply > 0 && ` / ${formatWatts(supply)}`}
      </span>
      {note && (
        <span className="-ml-1 text-[11px] text-muted-foreground">{note}</span>
      )}
    </span>
  )
}

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
  ...look
}: FigureLook & { power: RackPower | null | undefined }) {
  if (!hasPowerData(power)) return dash
  const demand = rackPowerDemand(power)
  return (
    <DemandFigure
      slot="power-figure"
      demand={demand.watts}
      nameplate={demand.nameplate}
      supply={power.available_w}
      supplyNote={powerSupplyNote(power)}
      missing="No feed"
      ratio={rackPowerRatio(power)}
      {...look}
    />
  )
}

/**
 * A rack's heat load against its cooling capacity (#434), read like its
 * power: **heat / capacity** ("3.2 kW / 10 kW"). Heat is each device's type
 * heat output where set, else its allocated draw - the nameplate sum where
 * nothing is allocated, marked *nameplate* - and a rack giving off heat with
 * no capacity recorded says *No capacity*. Heat above capacity turns red.
 */
export function CoolingFigure({
  cooling,
  ...look
}: FigureLook & { cooling: RackCooling | null | undefined }) {
  if (!hasCoolingData(cooling)) return dash
  const demand = rackCoolingDemand(cooling)
  return (
    <DemandFigure
      slot="cooling-figure"
      demand={demand.watts}
      nameplate={demand.nameplate}
      supply={cooling.available_w}
      supplyNote=""
      missing="No capacity"
      ratio={rackCoolingRatio(cooling)}
      {...look}
    />
  )
}
