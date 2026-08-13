import type * as React from "react"
import type { ReactNode } from "react"
import { Check } from "lucide-react"

import type {
  PlanningMilestone,
  PlanningPriority,
  PlanningStatus,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { DatePicker } from "@/components/ui/date-picker"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PriorityBadge } from "./task-card"

/**
 * A task's properties, as things you click rather than fields you fill in.
 *
 * The sheet used to render eight labelled form inputs and a Save button, which
 * read as an edit form for a task rather than the task itself. These follow the
 * inline-badge idiom already used for cable status (`CableStatusControl`): the
 * value *is* the control, and picking writes straight away — same as dragging a
 * card between columns, which the board has always done with one small PATCH.
 */

/**
 * The same labelled table `KvCard` gives every detail page — except the value
 * cell is the editor. Clicking a cell opens its picker; there is no separate
 * edit mode and no form to submit.
 */
export function PropertyTable({
  rows,
}: {
  rows: { label: string; value: ReactNode }[]
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow
              key={row.label}
              className={i % 2 === 1 ? "bg-muted/30" : undefined}
            >
              <TableCell className="w-28 py-1 text-xs text-muted-foreground">
                {row.label}
              </TableCell>
              <TableCell className="py-1 text-[13px] text-foreground">
                {row.value}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** The whole cell is the control, so the click target is the row you read
 *  rather than a small chip floating inside it.
 *
 *  It **must** spread its props: `DropdownMenuTrigger asChild` clones this
 *  element and injects the onClick, ref and aria state that make it a trigger.
 *  Accepting only the props it names silently swallowed them, and the cell
 *  looked clickable while doing nothing. */
function CellTrigger({
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      {...props}
      className={cn(
        "-mx-2 h-7 w-[calc(100%+1rem)] justify-start gap-1 px-2 font-normal",
        className
      )}
    >
      {children}
    </Button>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <span className="text-[12px] text-muted-foreground">{children}</span>
}

export function StatusPicker({
  statuses,
  value,
  onChange,
  canEdit,
}: {
  statuses: PlanningStatus[]
  value: string | null
  onChange: (id: string) => void
  canEdit: boolean
}) {
  const current = statuses.find((s) => s.id === value)
  const badge = current ? (
    <ColorBadge name={current.name} color={current.color || undefined} />
  ) : (
    <Empty>No status</Empty>
  )
  if (!canEdit) return <span className="pl-0.5">{badge}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <CellTrigger title="Move this task to another column">
          {badge}
        </CellTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {statuses.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => onChange(s.id)}
            className="gap-2"
          >
            <ColorBadge name={s.name} color={s.color || undefined} />
            {s.id === value && (
              <Check className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const PRIORITIES: { value: PlanningPriority; label: string }[] = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "None" },
]

export function PriorityPicker({
  value,
  onChange,
  canEdit,
}: {
  value: PlanningPriority
  onChange: (v: PlanningPriority) => void
  canEdit: boolean
}) {
  const badge =
    value === "none" ? <Empty>None</Empty> : <PriorityBadge priority={value} />
  if (!canEdit) return <span className="pl-0.5">{badge}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <CellTrigger title="Set priority">{badge}</CellTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {PRIORITIES.map((p) => (
          <DropdownMenuItem
            key={p.value}
            onSelect={() => onChange(p.value)}
            className="gap-2"
          >
            {p.value === "none" ? (
              <Empty>None</Empty>
            ) : (
              <PriorityBadge priority={p.value} />
            )}
            {p.value === value && (
              <Check className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MilestonePicker({
  milestones,
  value,
  onChange,
  canEdit,
  formatDate,
}: {
  milestones: PlanningMilestone[]
  value: string | null
  onChange: (id: string | null) => void
  canEdit: boolean
  formatDate: (v: string) => string
}) {
  const current = milestones.find((m) => m.id === value)
  const badge = current ? (
    <ColorBadge name={current.name} color={current.color || undefined} />
  ) : (
    <Empty>None</Empty>
  )
  if (!canEdit) return <span className="pl-0.5">{badge}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <CellTrigger title="Roll this task up to a milestone">
          {badge}
        </CellTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <Empty>No milestone</Empty>
          {!value && (
            <Check className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
          )}
        </DropdownMenuItem>
        {milestones.length > 0 && <DropdownMenuSeparator />}
        {milestones.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => onChange(m.id)}
            className="gap-2"
          >
            <ColorBadge name={m.name} color={m.color || undefined} />
            {m.due_date && (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {formatDate(m.due_date)}
              </span>
            )}
            {m.id === value && <Check className="h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Start → due on one line, each an inline date chip, with the "Due in 3 days"
 *  wording the card already shows so the sheet answers *when* the same way. */
export function DateRange({
  start,
  due,
  onChange,
  canEdit,
  schedule,
}: {
  start: string | null
  due: string | null
  onChange: (patch: {
    start_date?: string | null
    due_date?: string | null
  }) => void
  canEdit: boolean
  schedule: { text: string; tone: string } | null
}) {
  const chip =
    "-ml-1.5 h-7 w-auto justify-start border-0 bg-transparent px-1.5 font-normal shadow-none hover:bg-accent"
  if (!canEdit) {
    return (
      <span className="pt-1 text-[12px]">
        {start || due ? (
          <>
            {start ?? "—"} → {due ?? "—"}
          </>
        ) : (
          <Empty>Not scheduled</Empty>
        )}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <DatePicker
        value={start ?? ""}
        onChange={(v) => onChange({ start_date: v || null })}
        placeholder="Start"
        className={chip}
      />
      <span className="text-muted-foreground">→</span>
      <DatePicker
        value={due ?? ""}
        onChange={(v) => onChange({ due_date: v || null })}
        placeholder="Due"
        className={chip}
      />
      {schedule && (
        <span className={`ml-1 text-[11px] ${schedule.tone}`}>
          {schedule.text}
        </span>
      )}
    </div>
  )
}
