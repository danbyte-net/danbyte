import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
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
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** Where a hidden column is listed under "Available": the table's own
 * columns first, then the list's other fields, related objects, and custom
 * fields. */
export type ColumnGroup = "columns" | "fields" | "related" | "custom"

const GROUPS: { id: ColumnGroup; label: string }[] = [
  { id: "columns", label: "Columns" },
  { id: "fields", label: "Fields" },
  { id: "related", label: "Related" },
  { id: "custom", label: "Custom fields" },
]

/** A search box appears once the menu lists more than this many columns. */
const SEARCH_FROM = 12

export interface ColumnsMenuProps {
  label: string
  /** Admin-locked layout - the menu is read-only. */
  isForced: boolean
  /** The user has a saved layout → offer Reset. */
  hasUserRow: boolean
  /** Current manageable column order. */
  seq: string[]
  labelFor: (id: string) => string
  isHidden: (id: string) => boolean
  /** Section for a hidden column; everything is "columns" when omitted. */
  groupFor?: (id: string) => ColumnGroup
  /** More columns are on their way (the list-column catalog is loading). */
  loading?: boolean
  /** The menu is about to be used - hover, focus or open. Lets the table
   * start fetching the columns it only offers on demand. */
  onIntent?: () => void
  /** Commit a full layout (order + hidden ids) in one atomic write. The order
   * lists the shown columns first, then the hidden ones. */
  onApply: (order: string[], hidden: string[]) => void
  onReset: () => void
}

/**
 * The list-table "Columns" control. **Shown** lists the visible columns in
 * table order - drag to reorder, untick to hide. **Available** lists the rest
 * by section, alphabetically; ticking one adds it to the end of Shown. Edits
 * are staged in a local draft and written on Save as one atomic request, so
 * rapid toggles never race each other or the saved layout. Closing without
 * saving discards the draft.
 */
export function ColumnsMenu({
  label,
  isForced,
  hasUserRow,
  seq,
  labelFor,
  isHidden,
  groupFor,
  loading,
  onIntent,
  onApply,
  onReset,
}: ColumnsMenuProps) {
  const [open, setOpen] = useState(false)
  const [order, setOrder] = useState<string[]>(seq)
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(seq.filter(isHidden))
  )
  const [query, setQuery] = useState("")

  // Re-seed the draft from the live layout each time the menu opens.
  useEffect(() => {
    if (!open) return
    setOrder(seq)
    setHidden(new Set(seq.filter(isHidden)))
    setQuery("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Columns that arrive while the menu is open (the catalog loading) join
  // the draft as they are - hidden ones under Available.
  const seqKey = seq.join(" ")
  useEffect(() => {
    if (!open) return
    setOrder((prev) => {
      const fresh = seq.filter((id) => !prev.includes(id))
      return fresh.length ? [...prev, ...fresh] : prev
    })
    setHidden((prev) => {
      const fresh = seq.filter((id) => !order.includes(id) && isHidden(id))
      if (!fresh.length) return prev
      const next = new Set(prev)
      for (const id of fresh) next.add(id)
      return next
    })
  }, [seqKey])

  const shown = order.filter((id) => !hidden.has(id))
  const dirty = useMemo(() => {
    const savedShown = seq.filter((id) => !isHidden(id))
    if (savedShown.length !== shown.length) return true
    for (let i = 0; i < shown.length; i++)
      if (shown[i] !== savedShown[i]) return true
    return seq.some((id) => isHidden(id) !== hidden.has(id))
  }, [shown, hidden, seq, isHidden])

  const needle = query.trim().toLowerCase()
  const matches = (id: string) =>
    !needle || labelFor(id).toLowerCase().includes(needle)
  const available = GROUPS.map((g) => ({
    ...g,
    ids: order
      .filter(
        (id) =>
          hidden.has(id) &&
          (groupFor?.(id) ?? "columns") === g.id &&
          matches(id)
      )
      .sort((a, b) =>
        labelFor(a).localeCompare(labelFor(b), undefined, { numeric: true })
      ),
  })).filter((g) => g.ids.length)

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

  const hide = (id: string) =>
    setHidden((prev) => new Set(prev).add(id))
  const show = (id: string) => {
    // A column ticked from Available lands at the end of Shown.
    setOrder((prev) => {
      const rest = prev.filter((x) => x !== id)
      let at = 0
      rest.forEach((x, i) => {
        if (!hidden.has(x)) at = i + 1
      })
      return [...rest.slice(0, at), id, ...rest.slice(at)]
    })
    setHidden((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const save = () => {
    const hiddenIds = order.filter((id) => hidden.has(id))
    onApply([...shown, ...hiddenIds], hiddenIds)
    setOpen(false)
  }

  const searchable = order.length > SEARCH_FROM
  const shownMatching = shown.filter(matches)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) onIntent?.()
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onPointerEnter={onIntent}
          onFocus={onIntent}
        >
          {isForced && <Lock className="mr-1 h-3 w-3" />}
          {label}
          <ChevronDown className="ml-1 h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        {isForced ? (
          <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] text-muted-foreground">
            <Lock className="h-3 w-3" /> Layout locked by an administrator
          </div>
        ) : (
          <>
            {searchable && (
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search columns"
                aria-label="Search columns"
                className="mb-1.5 h-7 text-xs"
              />
            )}
            <div className="-mx-1 max-h-[55vh] overflow-y-auto px-1">
              <SectionTitle>Shown</SectionTitle>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={shownMatching}
                  strategy={verticalListSortingStrategy}
                >
                  {shownMatching.map((id) => (
                    <ColumnRow
                      key={id}
                      id={id}
                      label={labelFor(id)}
                      checked
                      draggable={!needle}
                      onToggle={() => hide(id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              {shownMatching.length === 0 && <Empty>None</Empty>}
              {(available.length > 0 || loading) && (
                <SectionTitle className="mt-1.5 border-t pt-2">
                  Available
                </SectionTitle>
              )}
              {available.map((g) => (
                <div key={g.id}>
                  {(available.length > 1 || g.id !== "columns") && (
                    <div className="px-1 pt-1 pb-0.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground">
                      {g.label}
                    </div>
                  )}
                  {g.ids.map((id) => (
                    <AvailableRow
                      key={id}
                      label={labelFor(id)}
                      onShow={() => show(id)}
                    />
                  ))}
                </div>
              ))}
              {loading && <Empty>Loading...</Empty>}
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

function SectionTitle({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "px-1 pb-1 text-[10px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase",
        className
      )}
    >
      {children}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 py-1 text-[11px] text-muted-foreground">
      {children}
    </div>
  )
}

function AvailableRow({
  label,
  onShow,
}: {
  label: string
  onShow: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50">
      <span aria-hidden className="-ml-0.5 w-3.5 shrink-0" />
      <Checkbox
        checked={false}
        onCheckedChange={() => onShow()}
        aria-label={`Toggle ${label}`}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  )
}

function ColumnRow({
  id,
  label,
  checked,
  draggable,
  onToggle,
}: {
  id: string
  label: string
  checked: boolean
  draggable: boolean
  onToggle: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !draggable })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50",
        isDragging && "relative z-10 bg-muted opacity-90 shadow-sm"
      )}
    >
      {draggable ? (
        <button
          type="button"
          className="-ml-0.5 cursor-grab touch-none text-muted-foreground/50 hover:text-foreground"
          aria-label={`Drag ${label}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span aria-hidden className="-ml-0.5 w-3.5 shrink-0" />
      )}
      <Checkbox
        checked={checked}
        onCheckedChange={() => onToggle()}
        aria-label={`Toggle ${label}`}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  )
}
