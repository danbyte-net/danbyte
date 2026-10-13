import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { PlanningTask } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { PriorityBadge, scheduleLabel } from "@/components/planning/task-card"

// The one source of truth for "a table of planning tasks" - the Tasks tab on
// object pages builds here; any later task table should too.

export type PlanningTaskColumnId =
  | "title"
  | "board"
  | "status"
  | "assignees"
  | "due"
  | "priority"

const CANONICAL_ORDER: PlanningTaskColumnId[] = [
  "title",
  "board",
  "status",
  "assignees",
  "due",
  "priority",
]

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

export interface PlanningTaskColumnOpts {
  omit?: PlanningTaskColumnId[]
  include?: PlanningTaskColumnId[]
  /** `useDateFormat()` bits - the factory stays hook-free. */
  today: string
  formatDate: (v: string) => string
}

/** "alice, bob", or the team queue when nobody has picked it up. */
export function taskAssigneeText(t: PlanningTask): string {
  if (t.assignee_detail.length > 0)
    return t.assignee_detail.map((a) => a.username).join(", ")
  return t.assigned_group_name ?? ""
}

export function buildPlanningTaskColumns(
  opts: PlanningTaskColumnOpts
): ColumnDef<PlanningTask, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: PlanningTaskColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))
  const { today, formatDate } = opts

  const byId: Record<
    PlanningTaskColumnId,
    () => ColumnDef<PlanningTask, unknown>
  > = {
    title: () => ({
      id: "title",
      accessorKey: "title",
      header: ({ column }) => <SortHeader column={column} label="Task" />,
      cell: ({ row }) => (
        <Link
          to="/planning/$boardId/tasks/$taskId"
          params={{ boardId: row.original.board, taskId: row.original.id }}
          className="link font-medium"
        >
          {row.original.title}
        </Link>
      ),
    }),
    board: () => ({
      id: "board",
      accessorKey: "board_name",
      header: ({ column }) => <SortHeader column={column} label="Board" />,
      cell: ({ row }) => (
        <Link
          to="/planning/$boardId"
          params={{ boardId: row.original.board }}
          className="link"
        >
          {row.original.board_name}
        </Link>
      ),
    }),
    status: () => ({
      id: "status",
      accessorKey: "status_name",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => (
        <ColorBadge
          name={row.original.status_name}
          color={row.original.status_color || undefined}
        />
      ),
    }),
    assignees: () => ({
      id: "assignees",
      accessorFn: (t) => taskAssigneeText(t),
      header: ({ column }) => <SortHeader column={column} label="Assignees" />,
      cell: ({ row }) => {
        const text = taskAssigneeText(row.original)
        return text ? (
          <span className="whitespace-nowrap">{text}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      },
    }),
    due: () => ({
      id: "due",
      // Undated sorts last; the time refines the order within a day.
      accessorFn: (t) =>
        t.due_date ? `${t.due_date}T${t.due_time ?? "99"}` : "9999",
      header: ({ column }) => <SortHeader column={column} label="Due" />,
      cell: ({ row }) => {
        const t = row.original
        if (!t.due_date) return <span className="text-muted-foreground">-</span>
        const s = scheduleLabel(
          { start_date: null, due_date: t.due_date },
          today,
          formatDate
        )
        const closed =
          t.status_group === "completed" || t.status_group === "cancelled"
        return (
          <span
            className={`num whitespace-nowrap ${closed ? "text-muted-foreground" : (s?.tone ?? "")}`}
          >
            {closed ? formatDate(t.due_date) : s?.text}
            {t.due_time ? ` ${t.due_time.slice(0, 5)}` : ""}
          </span>
        )
      },
    }),
    priority: () => ({
      id: "priority",
      accessorFn: (t) => PRIORITY_RANK[t.priority] ?? 9,
      header: ({ column }) => <SortHeader column={column} label="Priority" />,
      cell: ({ row }) =>
        row.original.priority === "none" ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <PriorityBadge priority={row.original.priority} />
        ),
    }),
  }

  return CANONICAL_ORDER.filter(keep).map((id) => byId[id]())
}
