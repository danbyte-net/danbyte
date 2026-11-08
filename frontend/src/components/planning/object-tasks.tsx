import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlarmClock, X } from "lucide-react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { PlanningOverdueTask, PlanningTask } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { DataTable } from "@/components/data-table"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { buildPlanningTaskColumns } from "@/components/columns/planning-task-columns"
import { AddTaskButton } from "./add-task"

// The object side of planning: which tasks touch this device/prefix/…, and -
// for the people doing them - which of those are past due. Both are
// route-derived and mounted once by DetailShell, so no detail page wires them.

function targetQuery(objectType: string, objectId: string): string {
  return new URLSearchParams({
    object_type: objectType,
    object_id: objectId,
  }).toString()
}

/** Tasks linked to one object; `open` drops completed/cancelled ones (the
 * status row's meaning, not its name). Shared by the tab count and the pane,
 * so the two never disagree and only one request goes out. */
export function useObjectTasks(
  objectType: string,
  objectId: string,
  { open, enabled = true }: { open: boolean; enabled?: boolean }
) {
  return useQuery({
    queryKey: ["planning-tasks", "for-object", objectType, objectId, open],
    queryFn: () =>
      apiAll<PlanningTask>(
        `/api/planning/tasks/?${targetQuery(objectType, objectId)}${open ? "&open=1" : ""}`
      ),
    enabled,
    staleTime: 30_000,
  })
}

/** Whether this user may see planning tasks at all - gates the tab. */
export function useCanViewTasks(): boolean {
  const { canDo } = useMe()
  return canDo("task", "view")
}

type Scope = "open" | "all"

export function ObjectTasksPanel({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const [scope, setScope] = useState<Scope>("open")
  const { today, formatDate } = useDateFormat()
  const q = useObjectTasks(objectType, objectId, { open: scope === "open" })
  const columns = useMemo(
    () => buildPlanningTaskColumns({ today, formatDate }),
    [today, formatDate]
  )
  const rows = q.data?.results ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SegmentedTabs<Scope>
          value={scope}
          onValueChange={setScope}
          items={[
            { value: "open", label: "Open" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="ml-auto">
          <AddTaskButton link={{ objectType, id: objectId }} />
        </div>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={scope === "open" ? "No open tasks." : "No tasks."} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          embedded
          enableExport={false}
          autoColumns={false}
          flexColumn="title"
        />
      )}
    </div>
  )
}

/**
 * "Your task on this object is past due." Shown only to the task's assignees
 * (or, for an unclaimed team-queue task, the team) - the server decides who,
 * and which dismissals still apply. A dismissal holds until the due date or
 * time moves.
 */
export function ObjectOverdueWarning({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const qc = useQueryClient()
  const { formatDate } = useDateFormat()
  const key = ["planning-tasks", "overdue", objectType, objectId]
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<PlanningOverdueTask[]>(
        `/api/planning/tasks/overdue/?${targetQuery(objectType, objectId)}`
      ),
    staleTime: 60_000,
  })
  const dismiss = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/planning/tasks/${id}/dismiss-overdue/`, {
        method: "POST",
      }),
    onSuccess: (_d, id) => {
      qc.setQueryData<PlanningOverdueTask[]>(key, (old) =>
        (old ?? []).filter((t) => t.id !== id)
      )
    },
    onError: (e) => apiErrorToast(e, "Could not dismiss"),
  })
  const tasks = q.data ?? []
  if (tasks.length === 0) return null

  return (
    <section
      aria-label="Overdue tasks"
      className="mx-4 my-3 overflow-hidden rounded-lg border border-amber-500/40 lg:mx-6"
    >
      <ul className="divide-y divide-border">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-1.5">
            <Badge variant="warning">
              <AlarmClock /> Overdue
            </Badge>
            <Link
              to="/planning/$boardId/tasks/$taskId"
              params={{ boardId: t.board, taskId: t.id }}
              className="link min-w-0 flex-1 truncate text-[13px] font-medium"
            >
              {t.title}
            </Link>
            <ColorBadge
              name={t.status_name}
              color={t.status_color || undefined}
            />
            <span className="num text-[11px] whitespace-nowrap text-muted-foreground">
              {formatDate(t.due_date)}
              {t.due_time ? ` ${t.due_time.slice(0, 5)}` : ""}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Dismiss ${t.title}`}
              disabled={dismiss.isPending && dismiss.variables === t.id}
              onClick={() => dismiss.mutate(t.id)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
