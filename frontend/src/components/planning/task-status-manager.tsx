import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/empty-state"
import { FormSelect } from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"

const GROUPS: { value: PlanningSemanticGroup; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Unstarted" },
  { value: "started", label: "Started" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
]

/** Manage a board's task statuses (kanban columns) — lives on the Statuses
 * page so every kind of status is edited in one place. Fully custom rows; the
 * semantic group tells Danbyte what a column *means* (is it done?). */
export function TaskStatusManager() {
  const { canDo } = useMe()
  const canEdit = canDo("taskstatus", "change")
  const canAdd = canDo("taskstatus", "add")
  const canDelete = canDo("taskstatus", "delete")
  const qc = useQueryClient()
  const [boardId, setBoardId] = useState<string | null>(null)

  const boardsQ = useQuery({
    queryKey: ["planning-boards"],
    queryFn: () => api<Paginated<PlanningBoard>>("/api/planning/boards/"),
  })
  const boards = boardsQ.data?.results ?? []
  const activeBoard = boardId ?? boards[0]?.id ?? null

  const statusesQ = useQuery({
    queryKey: ["planning-statuses", activeBoard],
    queryFn: () =>
      api<Paginated<PlanningStatus>>(
        `/api/planning/statuses/?board=${activeBoard}&page_size=100`
      ),
    enabled: !!activeBoard,
  })
  const statuses = statusesQ.data?.results ?? []

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["planning-statuses", activeBoard] })

  const create = useMutation({
    mutationFn: () =>
      api("/api/planning/statuses/", {
        method: "POST",
        body: JSON.stringify({
          board: activeBoard,
          name: "New status",
          semantic_group: "unstarted",
          weight: statuses.length
            ? Math.max(...statuses.map((s) => s.weight)) + 100
            : 100,
        }),
      }),
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/planning/statuses/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e),
  })

  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/planning/statuses/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Status deleted")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  if (boards.length === 0) {
    return (
      <EmptyState title="No boards yet.">
        Task statuses are the columns of a planning board — create a board under
        Planning first.
      </EmptyState>
    )
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-end gap-3">
        <div className="w-64">
          <FormSelect
            label="Board"
            value={activeBoard}
            onChange={setBoardId}
            options={boards.map((b) => ({ value: b.id, label: b.name }))}
          />
        </div>
        {canAdd && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!activeBoard || create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="h-3.5 w-3.5" /> Add status
          </Button>
        )}
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        {statuses.map((s) => (
          <StatusRow
            key={s.id}
            status={s}
            canEdit={canEdit}
            canDelete={canDelete}
            onPatch={(body) => patch.mutate({ id: s.id, body })}
            onDelete={() => del.mutate(s.id)}
          />
        ))}
        {statuses.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            This board has no statuses.
          </p>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The semantic group tells Danbyte what a column means — "Completed" and
        "Cancelled" count as closed regardless of what you name them. Lower
        weights sort further left on the board.
      </p>
    </div>
  )
}

function StatusRow({
  status,
  canEdit,
  canDelete,
  onPatch,
  onDelete,
}: {
  status: PlanningStatus
  canEdit: boolean
  canDelete: boolean
  onPatch: (body: Record<string, unknown>) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(status.name)
  const [color, setColor] = useState(status.color || "#a1a1aa")
  const [weight, setWeight] = useState(String(status.weight))

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <input
        type="color"
        value={color}
        disabled={!canEdit}
        onChange={(e) => setColor(e.target.value)}
        onBlur={() => color !== status.color && onPatch({ color })}
        className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent"
        title="Column color"
      />
      <Input
        value={name}
        disabled={!canEdit}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const v = name.trim()
          if (v && v !== status.name) onPatch({ name: v })
        }}
        className="h-8 w-44 text-[13px]"
      />
      <div className="w-40">
        <FormSelect
          label=""
          value={status.semantic_group}
          onChange={(v) => v && onPatch({ semantic_group: v })}
          options={GROUPS}
          disabled={!canEdit}
        />
      </div>
      <Input
        type="number"
        value={weight}
        disabled={!canEdit}
        onChange={(e) => setWeight(e.target.value)}
        onBlur={() => {
          const v = Number(weight)
          if (Number.isFinite(v) && v !== status.weight) onPatch({ weight: v })
        }}
        className="h-8 w-20 font-mono text-[13px]"
        title="Weight — lower sorts left"
      />
      {canDelete && (
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={onDelete}
          title="Delete status (must be empty)"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
