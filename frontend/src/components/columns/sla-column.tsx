import type { ColumnDef } from "@tanstack/react-table"

import type { AvailabilityFrame, SlaState, SlaStatusEntry } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { SortHeader } from "@/components/data-table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { AvailabilityCell } from "@/components/monitoring/availability"
import {
  SLA_STATE_LABEL,
  SlaFigureBadge,
  fmtBudget,
  fmtSla,
} from "@/components/monitoring/sla-figure"
import { FRAME_LABEL } from "@/components/monitoring/sla-status"

/** The rows' SLA figures and availability, from `useSlaStatus`. */
export interface SlaColumnOpts {
  entries: Record<string, SlaStatusEntry> | undefined
  frame: AvailabilityFrame
}

/**
 * The object's figure in its agreement's current period, coloured against
 * that agreement's own target. In several agreements, the strictest shows
 * and the tooltip lists them all. No SLA reads as a dash, never as failing.
 * A facet by state, so a list narrows to what is breached.
 */
export function slaColumn<T>(
  opts: SlaColumnOpts,
  getId: (r: T) => string | null | undefined
): ColumnDef<T, unknown> {
  const entry = (r: T) => {
    const id = getId(r)
    return id ? opts.entries?.[id] : undefined
  }
  return {
    id: "sla",
    accessorFn: (r) => {
      const l = entry(r)?.lowest
      return l?.availability != null ? l.availability - l.target : -1000
    },
    header: ({ column }) => <SortHeader column={column} label="SLA" />,
    cell: ({ row }) => {
      const e = entry(row.original)
      const low = e?.lowest
      if (!e || !low) return dash
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <SlaFigureBadge figures={low} />
            </span>
          </TooltipTrigger>
          <TooltipContent className="grid gap-1.5 text-xs">
            {e.sla.map((s) => (
              <div key={s.agreement.id} className="grid gap-0.5">
                <span className="font-medium">{s.agreement.name}</span>
                <span>
                  {fmtSla(s.availability)} of {fmtSla(s.target)} ·{" "}
                  {s.period_key}
                </span>
                <span>
                  {SLA_STATE_LABEL[s.state]} · budget left{" "}
                  {fmtBudget(s.budget_left_s)}
                  {s.worst_item ? ` · worst ${s.worst_item}` : ""}
                </span>
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      )
    },
    meta: {
      facet: {
        kind: "enum" as const,
        label: "SLA",
        get: (r: T) => entry(r)?.lowest?.state ?? "__none__",
        formatValue: (v: string) => ({
          label: v === "__none__" ? "No SLA" : SLA_STATE_LABEL[v as SlaState],
        }),
      },
    },
  }
}

/** Plain availability over the chosen frame - every check on the object,
 * in an SLA or not. */
export function availabilityColumn<T>(
  opts: SlaColumnOpts,
  getId: (r: T) => string | null | undefined
): ColumnDef<T, unknown> {
  const value = (r: T) => {
    const id = getId(r)
    return id ? opts.entries?.[id]?.availability : undefined
  }
  const label = FRAME_LABEL[opts.frame]
  return {
    id: "availability",
    accessorFn: (r) => value(r)?.availability ?? -1,
    header: ({ column }) => (
      <SortHeader
        column={column}
        label={label.length > 4 ? "Availability" : `Availability ${label}`}
      />
    ),
    cell: ({ row }) => (
      <AvailabilityCell figures={value(row.original) ?? undefined} />
    ),
  }
}
