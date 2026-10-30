import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { GripVertical, MoreHorizontal } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { FloorPlan, FloorPlanFloor, FloorPlanStack } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Field } from "@/components/forms"
import { Loading } from "@/components/loading"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** Refresh everything that shows floors: the stack, the plan, the lists. */
function useInvalidateFloors() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ["floor-plan-stack"] })
    void qc.invalidateQueries({ queryKey: ["floor-plan-stacks"] })
    void qc.invalidateQueries({ queryKey: ["floor-plan"] })
    void qc.invalidateQueries({ queryKey: ["floor-plans"] })
  }
}

const TOP = "top"

/** "+ Add floor": a name and where it goes, nothing else. */
export function AddFloorDialog({
  open,
  onOpenChange,
  stack,
  current,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stack: FloorPlanStack
  /** The floor on screen - the one whose grid and scale may be copied. */
  current?: FloorPlan
  onAdded: (plan: FloorPlan) => void
}) {
  const [name, setName] = useState("")
  const [position, setPosition] = useState(TOP)
  const [copy, setCopy] = useState(true)
  useEffect(() => {
    if (open) {
      setName("")
      setPosition(TOP)
      setCopy(true)
    }
  }, [open])
  const invalidate = useInvalidateFloors()
  const add = useMutation({
    mutationFn: () =>
      api<FloorPlan>(`/api/floor-plan-stacks/${stack.id}/floors/`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(position === TOP ? {} : { position: Number(position) }),
          ...(copy && current ? { copy_from: current.id } : {}),
        }),
      }),
    onSuccess: (plan) => {
      invalidate()
      onOpenChange(false)
      onAdded(plan)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add floor</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) add.mutate()
          }}
        >
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="2, Ground, B1…"
              className="h-9"
              maxLength={128}
            />
          </Field>
          <Field label="Position">
            <Select value={position} onValueChange={setPosition}>
              <SelectTrigger className="h-9 w-full" aria-label="Position">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TOP}>On top</SelectItem>
                {stack.floors.map((f, i) => (
                  <SelectItem key={f.id} value={String(i)}>
                    Below {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {current && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={copy}
                onCheckedChange={(v) => setCopy(v === true)}
              />
              <span className="whitespace-nowrap">
                Same grid and scale as {current.name}
              </span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || add.isPending}>
              {add.isPending ? "Adding…" : "Add floor"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Rename the floor plan (the stack) and edit its description. */
export function RenameStackDialog({
  open,
  onOpenChange,
  stack,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stack: FloorPlanStack
}) {
  const [name, setName] = useState(stack.name)
  const [description, setDescription] = useState(stack.description)
  useEffect(() => {
    if (open) {
      setName(stack.name)
      setDescription(stack.description)
    }
  }, [open, stack.name, stack.description])
  const invalidate = useInvalidateFloors()
  const save = useMutation({
    mutationFn: () =>
      api<FloorPlanStack>(`/api/floor-plan-stacks/${stack.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), description }),
      }),
    onSuccess: () => {
      invalidate()
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename floor plan</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) save.mutate()
          }}
        >
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9"
              maxLength={128}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The other floor plans at the stack's site - targets for a move or a
 * merge. */
function useSiteStacks(stack: FloorPlanStack, enabled: boolean) {
  return useQuery({
    queryKey: ["floor-plan-stacks", { site: stack.site.id }],
    queryFn: () =>
      apiAll<FloorPlanStack>(`/api/floor-plan-stacks/?site=${stack.site.id}`),
    enabled,
    select: (d) => d.results.filter((s) => s.id !== stack.id),
  })
}

/** Manage floors: drag to reorder, rename inline, move to another floor
 * plan, make a floor its own floor plan, delete. */
export function ManageFloorsDialog({
  open,
  onOpenChange,
  stack,
  currentId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stack: FloorPlanStack
  /** The floor on screen; deleting it opens another floor. */
  currentId: string
}) {
  const nav = useNavigate()
  const invalidate = useInvalidateFloors()
  const [order, setOrder] = useState<FloorPlanFloor[]>(stack.floors)
  useEffect(() => setOrder(stack.floors), [stack.floors])
  const [moving, setMoving] = useState<FloorPlanFloor | null>(null)
  const [deleting, setDeleting] = useState<FloorPlanFloor | null>(null)

  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api<FloorPlanStack>(`/api/floor-plan-stacks/${stack.id}/reorder/`, {
        method: "POST",
        body: JSON.stringify({ order: ids }),
      }),
    onSuccess: invalidate,
    onError: (e) => {
      setOrder(stack.floors)
      apiErrorToast(e)
    },
  })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<FloorPlan>(`/api/floor-plans/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: invalidate,
    onError: (e) => {
      setOrder(stack.floors)
      apiErrorToast(e)
    },
  })
  const split = useMutation({
    mutationFn: (f: FloorPlanFloor) =>
      api<FloorPlanStack>(`/api/floor-plans/${f.id}/split/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (created) => {
      invalidate()
      toast.success(`${created.name} is a floor plan of its own`)
    },
    onError: (e) => apiErrorToast(e),
  })
  const remove = useMutation({
    mutationFn: (f: FloorPlanFloor) =>
      api<void>(`/api/floor-plans/${f.id}/`, { method: "DELETE" }),
    onSuccess: (_, f) => {
      invalidate()
      setDeleting(null)
      toast.success(`Deleted ${f.name}`)
      if (f.id !== currentId) return
      const next = stack.floors.find((x) => x.id !== f.id)
      onOpenChange(false)
      if (next) void nav({ to: "/floorplans/$id", params: { id: next.id } })
      else void nav({ to: "/floorplans" })
    },
    onError: (e) => apiErrorToast(e),
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = order.findIndex((f) => f.id === active.id)
    const to = order.findIndex((f) => f.id === over.id)
    const next = arrayMove(order, from, to)
    setOrder(next)
    reorder.mutate(next.map((f) => f.id))
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Floors of {stack.name}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">Lowest first.</p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={order.map((f) => f.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="grid gap-1.5" aria-label="Floors">
                {order.map((f) => (
                  <li key={f.id}>
                    <FloorRow
                      floor={f}
                      current={f.id === currentId}
                      onRename={(name) => {
                        setOrder((o) =>
                          o.map((x) => (x.id === f.id ? { ...x, name } : x))
                        )
                        rename.mutate({ id: f.id, name })
                      }}
                      onMove={() => setMoving(f)}
                      onSplit={
                        order.length > 1 ? () => split.mutate(f) : undefined
                      }
                      onDelete={() => setDeleting(f)}
                    />
                  </li>
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <MoveFloorDialog
        stack={stack}
        floor={moving}
        onClose={() => setMoving(null)}
        onMoved={invalidate}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete floor ${deleting?.name ?? ""}?`}
        description={
          order.length === 1
            ? "Removes the floor and everything drawn on it, and the floor plan with it. Linked racks and devices are untouched."
            : "Removes the floor and everything drawn on it. Linked racks and devices are untouched."
        }
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  )
}

function FloorRow({
  floor,
  current,
  onRename,
  onMove,
  onSplit,
  onDelete,
}: {
  floor: FloorPlanFloor
  current: boolean
  onRename: (name: string) => void
  onMove: () => void
  onSplit?: () => void
  onDelete: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: floor.id })
  const [draft, setDraft] = useState(floor.name)
  useEffect(() => setDraft(floor.name), [floor.name])
  const commit = () => {
    const name = draft.trim()
    if (!name) setDraft(floor.name)
    else if (name !== floor.name) onRename(name)
  }
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1",
        isDragging && "opacity-60"
      )}
    >
      <button
        type="button"
        aria-label={`Reorder ${floor.name}`}
        className="cursor-grab text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
          if (e.key === "Escape") setDraft(floor.name)
        }}
        aria-label={`Name of ${floor.name}`}
        className={cn("h-8 flex-1", current && "font-medium")}
        maxLength={128}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${floor.name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onMove}>
            Move to floor plan…
          </DropdownMenuItem>
          {onSplit && (
            <DropdownMenuItem onSelect={onSplit}>
              Make its own floor plan
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Pick another floor plan at the same site for one floor. */
function MoveFloorDialog({
  stack,
  floor,
  onClose,
  onMoved,
}: {
  stack: FloorPlanStack
  floor: FloorPlanFloor | null
  onClose: () => void
  onMoved: () => void
}) {
  const others = useSiteStacks(stack, !!floor)
  const [target, setTarget] = useState("")
  useEffect(() => setTarget(""), [floor])
  const move = useMutation({
    mutationFn: () =>
      api<FloorPlan>(`/api/floor-plans/${floor!.id}/move/`, {
        method: "POST",
        body: JSON.stringify({ stack_id: target }),
      }),
    onSuccess: (plan) => {
      onMoved()
      toast.success(`Moved ${plan.name} to ${plan.stack?.name ?? ""}`)
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })
  const rows = others.data ?? []
  return (
    <Dialog open={!!floor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {floor?.name}</DialogTitle>
        </DialogHeader>
        {others.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other floor plan at {stack.site.name}.
          </p>
        ) : (
          <Field label="Floor plan">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="h-9 w-full" aria-label="Floor plan">
                <SelectValue placeholder="Pick a floor plan" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {s.location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!target || move.isPending}
            onClick={() => move.mutate()}
          >
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Merge other floor plans at the same site into this one: their floors
 * move here, after this one's, and the emptied floor plans go. */
export function MergeStacksDialog({
  open,
  onOpenChange,
  stack,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stack: FloorPlanStack
}) {
  const others = useSiteStacks(stack, open)
  const [picked, setPicked] = useState<string[]>([])
  useEffect(() => {
    if (open) setPicked([])
  }, [open])
  const invalidate = useInvalidateFloors()
  const merge = useMutation({
    mutationFn: () =>
      api<FloorPlanStack>(`/api/floor-plan-stacks/${stack.id}/merge/`, {
        method: "POST",
        body: JSON.stringify({ stacks: picked }),
      }),
    onSuccess: () => {
      invalidate()
      toast.success(`Merged into ${stack.name}`)
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  const rows = others.data ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Merge into {stack.name}</DialogTitle>
        </DialogHeader>
        {others.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other floor plan at {stack.site.name}.
          </p>
        ) : (
          <ul className="grid max-h-72 gap-1 overflow-y-auto">
            {rows.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                  <Checkbox
                    checked={picked.includes(s.id)}
                    onCheckedChange={(v) =>
                      setPicked((p) =>
                        v === true ? [...p, s.id] : p.filter((x) => x !== s.id)
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="num text-xs text-muted-foreground">
                    {s.floor_count} {s.floor_count === 1 ? "floor" : "floors"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={picked.length === 0 || merge.isPending}
            onClick={() => merge.mutate()}
          >
            {merge.isPending ? "Merging…" : "Merge"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
