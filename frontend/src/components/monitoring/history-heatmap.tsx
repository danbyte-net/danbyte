import { X } from "lucide-react"

import type { HeatCell } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { InfoTip } from "@/components/ui/info-tip"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export interface HeatCellPick {
  dow: number
  hour: number
}

/**
 * Status changes by weekday and hour, in the viewer's week. A 03:00 column
 * lit up on every row is a backup window; a Monday row is a boot storm.
 * Every cell is a filter: click one and the table below narrows to that
 * hour of that weekday; click it again, or the clear, to widen back. The
 * grid fills whatever height its card has. Plain CSS grid on the accent
 * token - a heatmap is layout, not a chart library's job.
 */
export function HistoryHeatmap({
  cells,
  selected,
  onSelect,
  className,
}: {
  cells: HeatCell[]
  selected?: HeatCellPick | null
  onSelect?: (cell: HeatCellPick | null) => void
  className?: string
}) {
  const grid = new Map<string, number>()
  let max = 0
  for (const c of cells) {
    grid.set(`${c.dow}:${c.hour}`, c.n)
    if (c.n > max) max = c.n
  }
  if (max === 0) return null
  return (
    <div className={"flex h-full flex-col " + (className ?? "")}>
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        By weekday and hour
        <InfoTip>
          Status changes by weekday and hour, in your timezone, over the current
          filter. Click a cell to narrow the table to it.
        </InfoTip>
        {selected && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-1.5 text-[11px] font-normal tracking-normal normal-case"
            onClick={() => onSelect?.(null)}
          >
            {DAYS[selected.dow]} {String(selected.hour).padStart(2, "0")}:00
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      <div
        className="grid min-h-0 flex-1 gap-px text-[10px] text-muted-foreground"
        style={{
          gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))",
          gridTemplateRows: "auto repeat(7, minmax(1rem, 1fr))",
        }}
      >
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="num text-center">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {DAYS.map((name, dow) => (
          <Row
            key={name}
            name={name}
            dow={dow}
            grid={grid}
            max={max}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}

function Row({
  name,
  dow,
  grid,
  max,
  selected,
  onSelect,
}: {
  name: string
  dow: number
  grid: Map<string, number>
  max: number
  selected?: HeatCellPick | null
  onSelect?: (cell: HeatCellPick | null) => void
}) {
  return (
    <>
      <span className="self-center pr-1 text-right leading-4">{name}</span>
      {Array.from({ length: 24 }, (_, hour) => {
        const n = grid.get(`${dow}:${hour}`) ?? 0
        const isSelected = selected?.dow === dow && selected.hour === hour
        const cell = (
          <button
            type="button"
            disabled={!n || !onSelect}
            aria-pressed={isSelected}
            aria-label={`${name} ${String(hour).padStart(2, "0")}:00, ${n} changes`}
            onClick={() => onSelect?.(isSelected ? null : { dow, hour })}
            className={
              "block h-full w-full rounded-[2px] bg-primary transition-opacity " +
              (n && onSelect ? "cursor-pointer hover:opacity-100 " : "") +
              (isSelected
                ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                : "")
            }
            style={{ opacity: n ? 0.15 + 0.85 * (n / max) : 0.05 }}
          />
        )
        if (!n) return <span key={hour}>{cell}</span>
        return (
          <Tooltip key={hour}>
            <TooltipTrigger asChild>
              <span>{cell}</span>
            </TooltipTrigger>
            <TooltipContent>
              {name} {String(hour).padStart(2, "0")}:00 ·{" "}
              <span className="num">{n}</span> change{n === 1 ? "" : "s"}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}
