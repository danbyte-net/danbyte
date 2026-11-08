import type { ReactNode } from "react"

import type { PrtgSensor } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { StatePill } from "@/components/monitoring/mixed-status-badge"

/**
 * The top-right corner of a sensor or channel tile: the state pill flush in
 * the corner and, on hover or focus, the tile's controls (unpin, actions)
 * fading in where it was while the pill slides left to make room. The room
 * is reserved up front, so nothing else on the tile moves; with reduced
 * motion the pill simply sits in its new place, and on a touch screen
 * (no hover) the controls always show.
 *
 * The tile is the hover group: give it `group/tile`.
 */

/** How far the pill slides and how much room is kept for it, per number of
 * 24px controls. Literal classes so Tailwind sees them. */
const SHIFT = [
  { slide: "", room: "" },
  {
    slide:
      "group-hover/tile:-translate-x-7 group-focus-within/tile:-translate-x-7 [@media(hover:none)]:-translate-x-7",
    room: "pl-7",
  },
  {
    slide:
      "group-hover/tile:-translate-x-[3.375rem] group-focus-within/tile:-translate-x-[3.375rem] [@media(hover:none)]:-translate-x-[3.375rem]",
    room: "pl-[3.375rem]",
  },
] as const

export function TileCorner({
  state,
  controls = [],
  className,
}: {
  /** The pill; absent leaves only the controls. */
  state?: ReactNode
  /** Up to two icon-only buttons (null entries are skipped). */
  controls?: ReactNode[]
  className?: string
}) {
  const shown = controls.filter(Boolean).slice(0, 2)
  const shift = SHIFT[state ? shown.length : 0]
  return (
    <div
      className={cn(
        "relative flex h-6 shrink-0 items-center justify-end",
        shift.room,
        className
      )}
      data-testid="tile-corner"
    >
      {state && (
        <span
          className={cn(
            "inline-flex transition-transform duration-150 ease-out motion-reduce:transition-none",
            shift.slide
          )}
        >
          {state}
        </span>
      )}
      {shown.length > 0 && (
        <span
          className={cn(
            "absolute inset-y-0 right-0 flex items-center gap-0.5 transition-opacity duration-150 motion-reduce:transition-none",
            state &&
              "opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100"
          )}
        >
          {shown.map((c, i) => (
            <span key={i} className="inline-flex">
              {c}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

/** A sensor's one state as a pill - Paused when paused, else its state -
 * with PRTG's own word and message in the shared tooltip. */
export function SensorStatePill({ sensor: s }: { sensor: PrtgSensor }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" data-testid="prtg-sensor-state">
          <StatePill state={s.paused ? "paused" : s.state || "unknown"} />
        </span>
      </TooltipTrigger>
      <TooltipContent variant="panel" className="max-w-xs text-[12px]">
        <span className="font-medium">{s.status || "Unknown"} in PRTG</span>
        {s.acknowledged && (
          <span className="text-muted-foreground"> · acknowledged</span>
        )}
        {s.message && (
          <span className="mt-1 block break-words text-muted-foreground">
            {s.message}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
