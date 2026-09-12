import type { HeatCell } from "@/lib/api"
import { InfoTip } from "@/components/ui/info-tip"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/**
 * When things break: status changes by weekday and hour, in the viewer's
 * week. A 03:00 column lit up on every row is a backup window; a Monday
 * row is a boot storm. Plain CSS grid on the accent token - a heatmap is
 * layout, not a chart library's job.
 */
export function HistoryHeatmap({
  cells,
  className,
}: {
  cells: HeatCell[]
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
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        When changes land
        <InfoTip>
          Status changes by weekday and hour, in your timezone, over the current
          filter.
        </InfoTip>
      </div>
      <div
        className="grid gap-px text-[10px] text-muted-foreground"
        style={{ gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))" }}
      >
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="num text-center">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {DAYS.map((name, dow) => (
          <Row key={name} name={name} dow={dow} grid={grid} max={max} />
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
}: {
  name: string
  dow: number
  grid: Map<string, number>
  max: number
}) {
  return (
    <>
      <span className="pr-1 text-right leading-4">{name}</span>
      {Array.from({ length: 24 }, (_, hour) => {
        const n = grid.get(`${dow}:${hour}`) ?? 0
        const cell = (
          <span
            className="block h-4 rounded-[2px] bg-primary"
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
