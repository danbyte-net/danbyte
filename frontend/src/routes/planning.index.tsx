import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { CalendarDays, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type PlanningBoard } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { TagList } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { BoardDialog } from "@/components/planning/board-dialog"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/planning/")({
  component: BoardListPage,
})

function BoardListPage() {
  const { canDo } = useMe()
  const canAdd = canDo("board", "add")
  const canEdit = canDo("board", "change")
  const canDelete = canDo("board", "delete")
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<PlanningBoard | null>(null)
  const [q, setQ] = useState("")
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<PlanningBoard[]>([])

  const query = useQuery({
    queryKey: ["planning-boards"],
    queryFn: () => api<Paginated<PlanningBoard>>("/api/planning/boards/"),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter((b) => {
        if (
          q &&
          !`${b.name} ${b.description}`.toLowerCase().includes(q.toLowerCase())
        )
          return false
        if (
          tagFilter.size > 0 &&
          !b.tags.some((t) => tagFilter.has(String(t.id)))
        )
          return false
        return true
      }),
    [allRows, q, tagFilter]
  )

  const tagFacets = useMemo(() => {
    const c = new Map<string, { label: string; count: number }>()
    for (const b of allRows)
      for (const t of b.tags) {
        const cur = c.get(String(t.id))
        if (cur) cur.count++
        else c.set(String(t.id), { label: t.name, count: 1 })
      }
    return [...c.entries()]
      .map(([value, e]) => ({ value, label: e.label, count: e.count }))
      .sort((a, b) => a.label.localeCompare(b.label)) as FacetOption[]
  }, [allRows])

  const del = useMutation({
    mutationFn: async (boards: PlanningBoard[]) => {
      for (const b of boards)
        await api(`/api/planning/boards/${b.id}/`, { method: "DELETE" })
      return boards.length
    },
    onSuccess: (n) => {
      toast.success(n === 1 ? "Board deleted" : `${n} boards deleted`)
      qc.invalidateQueries({ queryKey: ["planning-boards"] })
      setSelected([])
    },
    onError: (e) => {
      apiErrorToast(e)
      qc.invalidateQueries({ queryKey: ["planning-boards"] })
    },
  })

  const columns = useMemo<ColumnDef<PlanningBoard>[]>(
    () => [
      ...(canDelete ? [selectionColumn<PlanningBoard>()] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Board" />,
        cell: ({ row }) => (
          <Link
            to="/planning/$boardId"
            params={{ boardId: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      {
        id: "tags",
        header: "Tags",
        enableSorting: false,
        cell: ({ row }) => <TagList tags={row.original.tags} />,
      },
      {
        id: "tasks",
        accessorKey: "task_count",
        header: ({ column }) => <SortHeader column={column} label="Tasks" />,
        cell: ({ row }) => (
          <span className="num">{row.original.task_count}</span>
        ),
      },
      timeAgoColumn<PlanningBoard>({ get: (b) => b.updated_at }),
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => setEditing(row.original) : undefined}
            onDelete={canDelete ? () => del.mutate([row.original]) : undefined}
          />
        ),
      },
    ],
    [canEdit, canDelete, del]
  )

  return (
    <ListPageShell
      title="Planning"
      count={query.data ? rows.length : undefined}
      query={query}
      rail={
        tagFacets.length > 0 ? (
          <FilterRail>
            <FacetGroup
              label="Tags"
              options={tagFacets}
              selected={tagFilter}
              onToggle={(v) => toggleInSet(tagFilter, v, setTagFilter)}
            />
          </FilterRail>
        ) : undefined
      }
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          {selected.length > 0 && canDelete && (
            <Button
              size="sm"
              variant="outline"
              disabled={del.isPending}
              onClick={() => del.mutate(selected)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {del.isPending
                ? "Deleting..."
                : `Delete ${selected.length} board${selected.length === 1 ? "" : "s"}`}
            </Button>
          )}
          {/* The calendar reads across every board, so it belongs here rather
              than inside one of them. */}
          <Button size="sm" variant="outline" asChild>
            <Link to="/planning/calendar">
              <CalendarDays className="h-3.5 w-3.5" /> Calendar
            </Link>
          </Button>
          {canAdd && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> New board
            </Button>
          )}
        </>
      }
    >
      {allRows.length === 0 && query.data ? (
        <EmptyState title="No boards yet.">
          A board is a kanban surface for a team or a project — "DC migration",
          "Daily ops". Tasks on it can link straight to devices, prefixes,
          circuits and anything else Danbyte knows about.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          tableId="planning-boards"
          flexColumn="description"
          onSelectedRowsChange={setSelected}
        />
      )}
      {creating && <BoardDialog onOpenChange={setCreating} />}
      {editing && (
        <BoardDialog
          board={editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </ListPageShell>
  )
}
