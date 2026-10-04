import { CapacityBar } from "@/components/cells/capacity-bar"
import { dash } from "@/components/cells/dash"
import type { PortCountRow } from "@/lib/api"
import { capacityRatio } from "@/lib/rack-capacity"
import { portsUsed } from "@/lib/rack-port-state"
import { cn } from "@/lib/utils"

/** Ports in use over the ports counted, 0-1; null with none counted. */
export function portsRatio(
  row: PortCountRow | null | undefined
): number | null {
  return row ? capacityRatio(portsUsed(row), row.total) : null
}

/**
 * Ports in use - connected plus reserved, as the Port utilization page
 * counts them - over the ports counted: `38 / 48`. A rack's **Ports** and
 * **Panel ports** read this way on the racks list, the rack page, the floor
 * plan and a site's Capacity tab. `bar` leads with the capacity bar on the
 * racks' 80 / 95 % scale. With no port counted it is a dash.
 */
export function PortsFigure({
  row,
  bar = false,
  barClassName,
  className,
}: {
  row: PortCountRow | null | undefined
  /** Lead with the capacity bar. */
  bar?: boolean
  /** The bar's size, when the slot is narrower than a table cell. */
  barClassName?: string
  className?: string
}) {
  if (!row || row.total <= 0) return dash
  return (
    <span
      data-slot="ports-figure"
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap",
        className
      )}
    >
      {bar && <CapacityBar ratio={portsRatio(row)} className={barClassName} />}
      <span className={cn("num", bar && "text-[11px] text-muted-foreground")}>
        {portsUsed(row)} / {row.total}
      </span>
    </span>
  )
}
