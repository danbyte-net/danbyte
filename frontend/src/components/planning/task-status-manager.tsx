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
import { FormColor, FormSelect } from "@/components/forms"
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

const closedGroup = (g: PlanningSemanticGroup) =>
  g === "completed" || g === "cancelled"

/** One table row: a column *name*, aggregated across every board that has it.
 * Statuses are per-board rows underneath (each board can still diverge), but
 * the catalog view groups same-named columns so four boards don't read as
 * four duplicate "Done" rows. Edits fan out to every member. */
interface StatusGroup {
  key: string
  name: string
  color: string
  semantic_group: PlanningSemanticGroup
  weight: number
  is_default: boolean
  updated_at?: string
  members: PlanningStatus[]
}

function groupStatuses(rows: PlanningStatus[]): StatusGroup[] {
  const map = new Map<string, PlanningStatus[]>()
  for (const s of rows) {
    const key = s.name.trim().toLowerCase()
    const list = map.get(key)
    if (list) list.push(s)
    else map.set(key, [s])
  }
  return [...map.entries()].map(([key, members]) => {
    const rep = [...members].sort((a, b) => a.weight - b.weight)[0]
    return {
      key,
      name: rep.name,
      color: rep.color,
      semantic_group: rep.semantic_group,
      weight: rep.weight,
      is_default: members.some((m) => m.is_default),
      updated_at: members
        .map((m) => m.updated_at)
        .filter(Boolean)
        .sort()
        .at(-1),
      members,
    }
  })
}

/** Task statuses (kanban columns), presented like the object-status catalog:
 * shared list shell, facet rail, edit dialog. A closed column's tasks stop
 * generating due-date emails; a default column seeds new boards. */
export function TaskStatusManager() {
  const { canDo } = useMe()
  const canEdit = canDo("taskstatus", "change")
  const canAdd = canDo("taskstatus", "add")
  const canDelete = canDo("taskstatus", "delete")
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [boardFilter, setBoardFilter] = useState<Set<string>>(new Set())
  const [groupFilter, setGroupFilter] = useState<Set<string>>(new Set())
  const [doneFilter, setDoneFilter] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<StatusGroup | "new" | null>(null)

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
  const allGroups = useMemo(() => groupStatuses(allRows), [allRows])

  const rows = useMemo(
    () =>
      allGroups.filter((g) => {
        if (q && !g.name.toLowerCase().includes(q.toLowerCase())) return false
        if (
          boardFilter.size > 0 &&
          !g.members.some((m) => boardFilter.has(m.board))
        )
          return false
        if (groupFilter.size > 0 && !groupFilter.has(g.semantic_group))
          return false
        if (doneFilter.size === 1) {
          if (doneFilter.has("done") !== closedGroup(g.semantic_group))
            return false
        }
        return true
      }),
    [allGroups, q, boardFilter, groupFilter, doneFilter]
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

  const groupFacets = useMemo(() => {
    const c: Record<string, number> = {}
    for (const g of allGroups)
      c[g.semantic_group] = (c[g.semantic_group] ?? 0) + 1
    return GROUPS.filter((g) => c[g.value]).map((g) => ({
      value: g.value,
      label: g.label,
      count: c[g.value],
    })) as FacetOption[]
  }, [allGroups])

  const doneFacets = useMemo(() => {
    let done = 0
    for (const g of allGroups) if (closedGroup(g.semantic_group)) done++
    return [
      { value: "done", label: "Done", count: done },
      { value: "open", label: "Not done", count: allGroups.length - done },
    ].filter((o) => o.count) as FacetOption[]
  }, [allGroups])

  const del = useMutation({
    mutationFn: async (g: StatusGroup) => {
      for (const m of g.members)
        await api(`/api/planning/statuses/${m.id}/`, { method: "DELETE" })
    },
    onSuccess: () => {
      toast.success("Status deleted")
      qc.invalidateQueries({ queryKey: ["planning-statuses"] })
    },
    onError: (e) => {
      apiErrorToast(e)
      qc.invalidateQueries({ queryKey: ["planning-statuses"] })
    },
  })

  const columns = useMemo<ColumnDef<StatusGroup>[]>(
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
        id: "boards",
        accessorFn: (g) => g.members.length,
        header: ({ column }) => <SortHeader column={column} label="Boards" />,
        cell: ({ row }) => {
          const g = row.original
          if (boards.length > 1 && g.members.length === boards.length)
            return "All boards"
          return g.members
            .map((m) => boardName.get(m.board) ?? "?")
            .sort()
            .join(", ")
        },
      },
      {
        id: "group",
        accessorKey: "semantic_group",
        header: ({ column }) => (
          <SortHeader column={column} label="Semantic group" />
        ),
        cell: ({ row }) => GROUP_LABEL[row.original.semantic_group] ?? "-",
      },
      {
        id: "done",
        accessorFn: (g) => closedGroup(g.semantic_group),
        header: "Done",
        cell: ({ row }) =>
          closedGroup(row.original.semantic_group) ? (
            <span
              className="inline-flex items-center gap-1 text-[12px]"
              title="Counts as done - overdue tasks here stop sending reminder emails"
            >
              <Check className="h-3.5 w-3.5 text-primary" /> Done
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "default",
        accessorFn: (g) => g.is_default,
        header: "Default",
        cell: ({ row }) =>
          row.original.is_default ? (
            <span
              className="inline-flex items-center gap-1 text-[12px]"
              title="Copied onto newly created boards"
            >
              <Check className="h-3.5 w-3.5 text-primary" /> New boards
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "weight",
        accessorKey: "weight",
        header: ({ column }) => <SortHeader column={column} label="Weight" />,
        cell: ({ row }) => <span className="num">{row.original.weight}</span>,
      },
      timeAgoColumn<StatusGroup>({ get: (g) => g.updated_at }),
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => setEditing(row.original) : undefined}
            onDelete={canDelete ? () => del.mutate(row.original) : undefined}
          />
        ),
      },
    ],
    [boards.length, boardName, canEdit, canDelete, del]
  )

  if (boardsQ.data && boards.length === 0) {
    return (
      <EmptyState title="No boards yet.">
        Task statuses are the columns of a planning board - create a board under
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
          <FacetGroup
            label="Semantic group"
            options={groupFacets}
            selected={groupFilter}
            onToggle={(v) => toggleInSet(groupFilter, v, setGroupFilter)}
          />
          <FacetGroup
            label="Done"
            options={doneFacets}
            selected={doneFilter}
            onToggle={(v) => toggleInSet(doneFilter, v, setDoneFilter)}
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
        flexColumn="boards"
        tableId="task-statuses"
      />
      <p className="px-1 pt-2 text-[11px] text-muted-foreground">
        Each row is a column name grouped across the boards that carry it -
        saving a row updates every board's copy in one go. "Completed" and
        "Cancelled" count as done regardless of name: their tasks stop
        generating due-date reminder emails. "Default" columns seed newly
        created boards. Lower weights sort further left.
      </p>
      {editing && (
        <StatusDialog
          group={editing === "new" ? null : editing}
          boards={boards}
          existing={allRows}
          onClose={() => setEditing(null)}
        />
      )}
    </ListPageShell>
  )
}

const ALL_BOARDS = "__all__"

function StatusDialog({
  group,
  boards,
  existing,
  onClose,
}: {
  group: StatusGroup | null
  boards: PlanningBoard[]
  existing: PlanningStatus[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const isEdit = !!group
  const [name, setName] = useState(group?.name ?? "")
  const [board, setBoard] = useState<string | null>(
    boards.length > 1 ? ALL_BOARDS : (boards[0]?.id ?? null)
  )
  const [color, setColor] = useState(group?.color || "#a1a1aa")
  const [semGroup, setSemGroup] = useState<PlanningSemanticGroup>(
    group?.semantic_group ?? "unstarted"
  )
  const [weight, setWeight] = useState(String(group?.weight ?? 100))
  const [isDefault, setIsDefault] = useState(!!group?.is_default)

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        color,
        semantic_group: semGroup,
        weight: Number(weight) || 0,
        is_default: isDefault,
      }
      if (isEdit) {
        // Fan out: every board's copy of this column gets the same values.
        for (const m of group.members)
          await api(`/api/planning/statuses/${m.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        return
      }
      const targets =
        board === ALL_BOARDS ? boards.map((b) => b.id) : board ? [board] : []
      const taken = new Set(
        existing.map((s) => `${s.board}|${s.name.trim().toLowerCase()}`)
      )
      for (const b of targets) {
        if (taken.has(`${b}|${body.name.toLowerCase()}`)) continue
        await api("/api/planning/statuses/", {
          method: "POST",
          body: JSON.stringify({ ...body, board: b }),
        })
      }
    },
    onSuccess: () => {
      toast.success(isEdit ? "Status saved" : "Status added")
      qc.invalidateQueries({ queryKey: ["planning-statuses"] })
      onClose()
    },
    onError: (e) => {
      apiErrorToast(e)
      qc.invalidateQueries({ queryKey: ["planning-statuses"] })
    },
  })

  const done = semGroup === "completed" || semGroup === "cancelled"
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
              options={[
                ...(boards.length > 1
                  ? [{ value: ALL_BOARDS, label: "All boards" }]
                  : []),
                ...boards.map((b) => ({ value: b.id, label: b.name })),
              ]}
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
            <div className="w-44">
              <FormColor
                label="Color"
                value={color}
                onChange={setColor}
                allowEmpty={false}
              />
            </div>
          </div>
          <div className="flex items-end gap-3">
            <div className="w-44">
              <FormSelect
                label="Semantic group"
                value={semGroup}
                onChange={(v) => v && setSemGroup(v as PlanningSemanticGroup)}
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
            title="Tasks in this column count as done - overdue ones stop sending reminder emails"
          >
            <Checkbox
              checked={done}
              onCheckedChange={(v) =>
                setSemGroup(v ? "completed" : "unstarted")
              }
            />
            Done - mutes due-date reminders for its tasks
          </label>
          <label
            className="flex items-center gap-1.5 text-sm"
            title="Newly created boards start with the columns flagged here instead of the built-in four"
          >
            <Checkbox
              checked={isDefault}
              onCheckedChange={(v) => setIsDefault(!!v)}
            />
            Default - create this column on new boards
          </label>
          {isEdit && group.members.length > 1 && (
            <p className="text-[11px] text-muted-foreground">
              Saving updates this column on all {group.members.length} boards
              that have it.
            </p>
          )}
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
