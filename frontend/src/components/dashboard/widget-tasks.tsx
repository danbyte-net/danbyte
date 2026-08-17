import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated, PlanningTask } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { PriorityBadge, scheduleLabel } from "@/components/planning/task-card"
import { ColorBadge } from "@/components/cells/color-badge"

// Dashboard widget: the signed-in user's open tasks, most urgent first.
// `assignee=me&open=1` keeps the query server-side — "open" is the status
// row's semantic group, so renamed columns still count correctly.

function useMyTasks() {
  return useQuery({
    queryKey: ["planning-tasks", "mine-open"],
    queryFn: () =>
      api<Paginated<PlanningTask>>(
        "/api/planning/tasks/?assignee=me&open=1&page_size=100"
      ),
    staleTime: 60_000,
  })
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

export function MyTasksWidget() {
  const q = useMyTasks()
  const { formatDate, today } = useDateFormat()

  const rows = [...(q.data?.results ?? [])].sort((a, b) => {
    // Overdue first, then by due date, then priority — the answer to "what
    // should I look at" without opening a board.
    const dueA = a.due_date ?? "9999"
    const dueB = b.due_date ?? "9999"
    if (dueA !== dueB) return dueA < dueB ? -1 : 1
    return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
  })

  const columns: SimpleColumn<PlanningTask>[] = [
    {
      id: "title",
      header: "Task",
      flex: true,
      cell: (t) => (
        <Link
          to="/planning/$boardId/tasks/$taskId"
          params={{ boardId: t.board, taskId: t.id }}
          className="link truncate font-medium"
        >
          {t.title}
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (t) => <ColorBadge name={t.status_name} />,
    },
    {
      id: "priority",
      header: "Priority",
      cell: (t) =>
        t.priority === "none" ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <PriorityBadge priority={t.priority} />
        ),
    },
    {
      id: "due",
      header: "Due",
      align: "right",
      cell: (t) => {
        const s = scheduleLabel(t, today, formatDate)
        return s ? (
          <span className={`text-[11px] ${s.tone}`}>{s.text}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
  ]

  return (
    <SimpleTable
      columns={columns}
      data={rows}
      getRowKey={(t) => t.id}
      empty={q.isLoading ? "Loading..." : "Nothing assigned to you. Enjoy it."}
    />
  )
}
