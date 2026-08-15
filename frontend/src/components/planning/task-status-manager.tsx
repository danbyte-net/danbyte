import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Check } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PlanningBoard,
  type PlanningSemanticGroup,
  type PlanningStatus,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { EmptyState } from "@/components/empty-state"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { FormSelect } from "@/components/forms"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { apiErrorToast } from "@/lib/api-toast"

const GROUPS: { value: PlanningSemanticGroup; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Unstarted" },
  { value: "started", label: "Started" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
]
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.value, g.label]))

const isClosed = (s: PlanningStatus) =>
  s.semantic_group === "completed" || s.semantic_group === "cancelled"

/** Task statuses (kanban columns), presented exactly like the object-status
 * catalog: shared list shell, facet rail, one row per column across every
 * board. Rows are fully user-editable; the semantic group carries what a
 * column *means* (a closed column's tasks stop generating due-date emails). */
export function TaskStatusManager() {
  const { canDo } = useMe()
  const canEdit = canDo("taskstatus", "change")
  const canAdd = canDo("taskstatus", "add")
  const canDelete = canDo("taskstatus", "delete")
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [boardFilter, setBoardFilter] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<PlanningStatus | "new" | null>(null)

  const boardsQ = useQuery({
    queryKey: ["planning-boards"],
    queryFn: () => api<Paginated<PlanningBoard>>("/api/planning/boards/"),
  })
  const boards = boardsQ.data?.results ?? []
  const boardName = useMemo(
    () => new Map(boards.map((b) => [b.id, b.name])),
    [boards]
  )

  const query = useQuery({
    queryKey: ["planning-statuses", "all"],
    queryFn: () =>
      api<Paginated<PlanningStatus>>("/api/planning/statuses/?page_size=500"),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter((s) => {
        if (q && !s.name.toLowerCase().includes(q.toLowerCase())) return false
        if (boardFilter.size > 0 && !boardFilter.has(s.board)) return false
        return true
      }),
    [allRows, q, boardFilter]
  )

  const boardFacets = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of allRows) c[s.board] = (c[s.board] ?? 0) + 1
    return Object.entries(c)
      .map(([value, count]) => ({
        value,
        label: boardName.get(value) ?? value,
        count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)) as FacetOption[]
  }, [allRows, boardName])

  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/planning/statuses/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Status deleted")
      qc.invalidateQueries({ queryKey: ["planning-statuses"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<PlanningStatus>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        ),
      },
      {
        id: "board",
        accessorFn: (r) => boardName.get(r.board) ?? "",
        header: ({ column }) => <SortHeader column={column} label="Board" />,
        cell: ({ row }) => boardName.get(row.original.board) ?? "—",
      },
      {
        id: "group",
        accessorKey: "semantic_group",
        header: ({ column }) => (
          <SortHeader column={column} label="Semantic group" />
        ),
        cell: ({ row }) => GROUP_LABEL[row.original.semantic_group] ?? "—",
      },
      {
        id: "done",
        accessorFn: (r) => isClosed(r),
        header: "Done",
        cell: ({ row }) =>
          isClosed(row.original) ? (
            <span
              className="inline-flex items-center gap-1 text-[12px]"
              title="Counts as done — overdue tasks here stop sending reminder emails"
            >
              <Check className="h-3.5 w-3.5 text-primary" /> Done
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "weight",
        accessorKey: "weight",
        header: ({ column }) => <SortHeader column={column} label="Weight" />,
        cell: ({ row }) => <span className="num">{row.original.weight}</span>,
      },
      timeAgoColumn<PlanningStatus>({ get: (r) => r.updated_at }),
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => setEditing(row.original) : undefined}
            onDelete={canDelete ? () => del.mutate(row.original.id) : undefined}
          />
        ),
      },
    ],
    [boardName, canEdit, canDelete, del]
  )

  if (boardsQ.data && boards.length === 0) {
    return (
      <EmptyState title="No boards yet.">
        Task statuses are the columns of a planning board — create a board under
        Planning first.
      </EmptyState>
    )
  }

  return (
    <ListPageShell
      title="Task statuses"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Board"
            options={boardFacets}
            selected={boardFilter}
            onToggle={(v) => toggleInSet(boardFilter, v, setBoardFilter)}
          />
        </FilterRail>
      }
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        canAdd ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            Add status
          </Button>
        ) : undefined
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="board"
        tableId="task-statuses"
      />
      <p className="px-1 pt-2 text-[11px] text-muted-foreground">
        These are the board columns under Planning. "Completed" and "Cancelled"
        count as done regardless of name: their tasks stop generating due-date
        reminder emails and leave the digest's planned-work section. Lower
        weights sort further left on the board.
      </p>
      {editing && (
        <StatusDialog
          status={editing === "new" ? null : editing}
          boards={boards}
          onClose={() => setEditing(null)}
        />
      )}
    </ListPageShell>
  )
}

function StatusDialog({
  status,
  boards,
  onClose,
}: {
  status: PlanningStatus | null
  boards: PlanningBoard[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const isEdit = !!status
  const [name, setName] = useState(status?.name ?? "")
  const [board, setBoard] = useState<string | null>(
    status?.board ?? boards[0]?.id ?? null
  )
  const [color, setColor] = useState(status?.color || "#a1a1aa")
  const [group, setGroup] = useState<PlanningSemanticGroup>(
    status?.semantic_group ?? "unstarted"
  )
  const [weight, setWeight] = useState(String(status?.weight ?? 100))

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        color,
        semantic_group: group,
        weight: Number(weight) || 0,
      }
      if (isEdit)
        return api(`/api/planning/statuses/${status.id}/`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      return api("/api/planning/statuses/", {
        method: "POST",
        body: JSON.stringify({ ...body, board }),
      })
    },
    onSuccess: () => {
      toast.success(isEdit ? "Status saved" : "Status added")
      qc.invalidateQueries({ queryKey: ["planning-statuses"] })
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  const done = group === "completed" || group === "cancelled"
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit status" : "Add status"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!isEdit && (
            <FormSelect
              label="Board"
              value={board}
              onChange={setBoard}
              options={boards.map((b) => ({ value: b.id, label: b.name }))}
            />
          )}
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-10 cursor-pointer rounded-md border border-border bg-transparent"
              title="Column color"
            />
          </div>
          <div className="flex items-end gap-3">
            <div className="w-44">
              <FormSelect
                label="Semantic group"
                value={group}
                onChange={(v) => v && setGroup(v as PlanningSemanticGroup)}
                options={GROUPS}
              />
            </div>
            <div className="w-24 space-y-1.5">
              <label className="text-xs text-muted-foreground">Weight</label>
              <Input
                type="number"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className="num"
              />
            </div>
          </div>
          <label
            className="flex items-center gap-1.5 text-sm"
            title="Tasks in this column count as done — overdue ones stop sending reminder emails"
          >
            <Checkbox
              checked={done}
              onCheckedChange={(v) => setGroup(v ? "completed" : "unstarted")}
            />
            Done — mutes due-date reminders for its tasks
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || (!isEdit && !board) || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
