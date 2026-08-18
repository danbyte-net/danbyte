import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type PlanningMilestone } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ColorPicker } from "@/components/ui/color-picker"
import { DatePicker } from "@/components/ui/date-picker"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiErrorToast } from "@/lib/api-toast"

/** Milestones for one board: create, rename, redate, recolor, delete. Editing
 * is inline-on-blur like the status manager, so there is no second save step.
 * Deleting a milestone leaves its tasks in place (the FK is SET_NULL). */
export function MilestoneManagerDialog({
  boardId,
  open,
  onOpenChange,
}: {
  boardId: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { canDo } = useMe()
  const canAdd = canDo("milestone", "add")
  const canEdit = canDo("milestone", "change")
  const canDelete = canDo("milestone", "delete")
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ["planning-milestones", boardId],
    queryFn: () =>
      api<Paginated<PlanningMilestone>>(
        `/api/planning/milestones/?board=${boardId}&page_size=100`
      ),
  })
  const rows = q.data?.results ?? []

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["planning-milestones", boardId] })
    qc.invalidateQueries({ queryKey: ["planning-tasks", boardId] })
  }

  const create = useMutation({
    mutationFn: () =>
      api("/api/planning/milestones/", {
        method: "POST",
        body: JSON.stringify({
          board: boardId,
          name: `Milestone ${rows.length + 1}`,
          weight: rows.length
            ? Math.max(...rows.map((m) => m.weight)) + 100
            : 100,
        }),
      }),
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/planning/milestones/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e),
  })

  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/planning/milestones/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Milestone deleted")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Milestones</DialogTitle>
        </DialogHeader>

        <div className="divide-y divide-border rounded-lg border border-border">
          {q.isLoading && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Loading...
            </p>
          )}
          {!q.isLoading && rows.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No milestones on this board yet. A milestone is a target tasks
              roll up to &mdash; "Rack A cutover", "Q3 audit".
            </p>
          )}
          {rows.map((m) => (
            <MilestoneRow
              key={m.id}
              milestone={m}
              canEdit={canEdit}
              canDelete={canDelete}
              onPatch={(body) => patch.mutate({ id: m.id, body })}
              onDelete={() => del.mutate(m.id)}
            />
          ))}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Deleting a milestone keeps its tasks &mdash; they simply lose the
          milestone. Lower weights sort first.
        </p>

        <DialogFooter>
          {canAdd && (
            <Button
              variant="secondary"
              size="sm"
              className="mr-auto"
              disabled={create.isPending}
              onClick={() => create.mutate()}
            >
              <Plus className="h-3.5 w-3.5" /> Add milestone
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MilestoneRow({
  milestone,
  canEdit,
  canDelete,
  onPatch,
  onDelete,
}: {
  milestone: PlanningMilestone
  canEdit: boolean
  canDelete: boolean
  onPatch: (body: Record<string, unknown>) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(milestone.name)
  const [color, setColor] = useState(milestone.color)
  const [weight, setWeight] = useState(String(milestone.weight))

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <ColorPicker
        value={color}
        onChange={(v) => {
          setColor(v)
          if (v !== milestone.color) onPatch({ color: v })
        }}
      />
      <Input
        value={name}
        disabled={!canEdit}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const v = name.trim()
          if (v && v !== milestone.name) onPatch({ name: v })
        }}
        className="h-8 w-48 text-[13px]"
      />
      <div className="w-44">
        <DatePicker
          value={milestone.due_date ?? ""}
          disabled={!canEdit}
          placeholder="No due date"
          className="h-8 text-[13px]"
          onChange={(iso) => onPatch({ due_date: iso || null })}
        />
      </div>
      <Input
        type="number"
        value={weight}
        disabled={!canEdit}
        onChange={(e) => setWeight(e.target.value)}
        onBlur={() => {
          const v = Number(weight)
          if (Number.isFinite(v) && v !== milestone.weight)
            onPatch({ weight: v })
        }}
        className="h-8 w-20 font-mono text-[13px]"
        title="Weight — lower sorts first"
      />
      <span className="text-[12px] text-muted-foreground">
        {milestone.task_count} task{milestone.task_count === 1 ? "" : "s"}
      </span>
      {canDelete && (
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          title="Delete milestone"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
