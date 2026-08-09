import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { CalendarClock } from "lucide-react"

import { api, type PlanningPlannedChange } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { scheduleLabel } from "@/components/planning/task-card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * "A change is planned for this object."
 *
 * Deliberately unlike its neighbours on a device hero: compliance is an amber
 * warning triangle ("a rule you wrote isn't satisfied"), drift is compare-arrows
 * ("the device reports something else"). This is a calendar clock in the primary
 * tint — informational and scheduled, not wrong-now — because a planned change
 * means *nothing is wrong yet*. Renders nothing when nothing is planned, so it
 * can sit anywhere unconditionally.
 */

export interface PlannedTargetRow {
  count: number
  tasks: number
  task_id: string
  board_id: string
  task_title: string
  next_due: string | null
  samples: { field: string; from: string; to: string }[]
}

/** "api.interface" + id → the map key the fleet endpoint uses. */
export function plannedKey(objectType: string, objectId: string): string {
  return `${objectType}:${objectId}`
}

/**
 * Every open plan, keyed by target. ONE request for a whole table — the endpoint
 * pre-groups server-side precisely so a per-row badge doesn't become an N+1.
 */
export function usePlannedChangeMap(): Map<string, PlannedTargetRow> {
  const q = useQuery({
    queryKey: ["planned-changes-map"],
    queryFn: () =>
      api<{ targets: Record<string, PlannedTargetRow> }>(
        "/api/planning/planned-changes/map/"
      ),
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  })
  return useMemo(() => new Map(Object.entries(q.data?.targets ?? {})), [q.data])
}

/** The open change sets for one object — what the edit form's notice lists. */
export function usePlannedChanges(
  objectType: string,
  objectId: string | undefined
): PlanningPlannedChange[] {
  const q = useQuery({
    queryKey: ["planned-changes-for", objectType, objectId],
    queryFn: () =>
      api<{ results: PlanningPlannedChange[] }>(
        `/api/planning/planned-changes/?object_type=${objectType}` +
          `&object_id=${objectId}&state=planned&page_size=50`
      ),
    enabled: !!objectId,
    staleTime: 60_000,
  })
  return q.data?.results ?? []
}

function Body({ row }: { row: PlannedTargetRow }) {
  const { formatDate, today } = useDateFormat()
  const when = row.next_due
    ? scheduleLabel(
        { start_date: null, due_date: row.next_due },
        today,
        formatDate
      )
    : null
  return (
    <div className="space-y-1">
      <p className="font-medium">
        {row.count} change{row.count === 1 ? "" : "s"} planned
      </p>
      <p className="text-muted-foreground">
        {when ? `${when.text} · ` : ""}
        {row.task_title}
        {row.tasks > 1 ? ` (+${row.tasks - 1} more task)` : ""}
      </p>
      {row.samples.map((s, i) => (
        <p key={i} className="text-muted-foreground">
          {s.field}: {s.from || "—"} → {s.to || "—"}
        </p>
      ))}
      <p className="text-muted-foreground italic">
        Declared on a task. Nothing changes until someone applies it.
      </p>
    </div>
  )
}

/** Quiet row marker for tables. */
export function PlannedChangeMarker({
  objectType,
  objectId,
  map,
  className,
}: {
  objectType: string
  objectId: string
  map?: Map<string, PlannedTargetRow>
  className?: string
}) {
  const own = usePlannedChangeMap()
  const row = (map ?? own).get(plannedKey(objectType, objectId))
  if (!row) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 items-center text-primary",
            className
          )}
          aria-label={`${row.count} change${row.count === 1 ? "" : "s"} planned`}
        >
          <CalendarClock className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="max-w-xs flex-col items-start gap-0.5 text-[11px]"
      >
        <Body row={row} />
      </TooltipContent>
    </Tooltip>
  )
}

/** Hero pill — labelled, so a device page states it outright. */
export function PlannedChangeBadge({
  objectType,
  objectId,
  map,
  prominent,
  className,
}: {
  objectType: string
  objectId: string
  map?: Map<string, PlannedTargetRow>
  prominent?: boolean
  className?: string
}) {
  const own = usePlannedChangeMap()
  const row = (map ?? own).get(plannedKey(objectType, objectId))
  if (!row) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/planning/$boardId"
          params={{ boardId: row.board_id }}
          search={{ task: row.task_id }}
          className={cn(
            "inline-flex items-center gap-1 rounded-[5px] text-[11px] font-medium",
            prominent
              ? "bg-primary/10 px-1.5 py-0.5 text-primary ring-1 ring-primary/20"
              : "text-primary",
            className
          )}
        >
          <CalendarClock className="h-3 w-3" />
          {row.count} planned
        </Link>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="max-w-xs flex-col items-start gap-0.5 text-[11px]"
      >
        <Body row={row} />
      </TooltipContent>
    </Tooltip>
  )
}

/** Tab marker, mirroring the drift dot. */
export function PlannedDot({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "ml-1 inline-block size-1.5 rounded-full bg-primary",
        className
      )}
      aria-label="Changes planned"
    />
  )
}
