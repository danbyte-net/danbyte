import { useEffect, useMemo, useState } from "react"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronDown, GripVertical, Lock, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface ColumnsMenuProps {
  label: string
  /** Admin-locked layout — the menu is read-only. */
  isForced: boolean
  /** The user has a saved layout → offer Reset. */
  hasUserRow: boolean
  /** Current saved manageable column order. */
  seq: string[]
  labelFor: (id: string) => string
  isHidden: (id: string) => boolean
  /** Commit a full layout (order + hidden ids) in one atomic write. */
  onApply: (order: string[], hidden: string[]) => void
  onReset: () => void
}

/**
 * The list-table "Columns" control: drag to reorder (grip handle), tick to
 * show/hide, then **Save**. Edits are staged in a local draft and only written
 * on Save — one atomic request, so rapid toggles never race each other or the
 * saved layout (the old per-toggle auto-save could drop changes / re-check
 * boxes). Closing without saving discards the draft.
 */
export function ColumnsMenu({
  label,
  isForced,
  hasUserRow,
  seq,
  labelFor,
  isHidden,
  onApply,
  onReset,
}: ColumnsMenuProps) {
  const [open, setOpen] = useState(false)
  const [order, setOrder] = useState<string[]>(seq)
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(seq.filter(isHidden))
  )

  // Re-seed the draft from the live saved layout each time the menu opens.
  useEffect(() => {
    if (!open) return
    setOrder(seq)
    setHidden(new Set(seq.filter(isHidden)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const dirty = useMemo(() => {
    if (order.length !== seq.length) return true
    for (let i = 0; i < order.length; i++)
      if (order[i] !== seq[i]) return true
    for (const id of seq) if (isHidden(id) !== hidden.has(id)) return true
    return false
  }, [order, hidden, seq, isHidden])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setOrder((prev) => {
      const from = prev.indexOf(String(active.id))
      const to = prev.indexOf(String(over.id))
      if (from < 0 || to < 0) return prev
      return arrayMove(prev, from, to)
    })
  }

  const save = () => {
    onApply(order, [...hidden])
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
          {isForced && <Lock className="mr-1 h-3 w-3" />}
          {label}
          <ChevronDown className="ml-1 h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        {isForced ? (
          <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] text-muted-foreground">
            <Lock className="h-3 w-3" /> Layout locked by an administrator
          </div>
        ) : (
          <>
            <div className="mb-1 px-1 text-[11px] text-muted-foreground">
              Drag to reorder · tick to show
            </div>
            <div className="-mx-1 max-h-[55vh] overflow-y-auto px-1">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={order}
                  strategy={verticalListSortingStrategy}
                >
                  {order.map((id) => (
                    <ColumnRow
                      key={id}
                      id={id}
                      label={labelFor(id)}
                      checked={!hidden.has(id)}
                      onToggle={(v) =>
                        setHidden((prev) => {
                          const next = new Set(prev)
                          if (v) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
            <div className="mt-2 flex items-center gap-2 border-t pt-2">
              <Button
                size="sm"
                className="h-7 flex-1"
                disabled={!dirty}
                onClick={save}
              >
                Save
              </Button>
              {hasUserRow && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-muted-foreground"
                  onClick={() => {
                    onReset()
                    setOpen(false)
                  }}
                >
                  <RotateCcw className="mr-1 h-3 w-3" /> Reset
                </Button>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function ColumnRow({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string
  label: string
  checked: boolean
  onToggle: (v: boolean) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50",
        isDragging && "relative z-10 bg-muted opacity-90 shadow-sm"
      )}
    >
      <button
        type="button"
        className="-ml-0.5 cursor-grab touch-none text-muted-foreground/50 hover:text-foreground"
        aria-label={`Drag ${label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onToggle(!!v)}
        aria-label={`Toggle ${label}`}
      />
      <span className="flex-1 truncate">{label}</span>
    </div>
  )
}
