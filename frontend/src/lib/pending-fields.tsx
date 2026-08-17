import { createContext, useContext, useMemo, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { CalendarClock } from "lucide-react"

import { useDateFormat } from "@/lib/datetime"
import { usePlanTarget } from "@/lib/save-object"
import { usePlannedChanges } from "@/components/planning/planned-change-badge"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

/**
 * "This value might change soon", marked on the individual field.
 *
 * A planned change names the fields it touches, so the field itself is where the
 * warning belongs — a block of text above the form makes the reader hunt for
 * which input it means. `Field` and `KvCard` consult this context and render a
 * small calendar-clock beside the affected label; everything else is unaffected
 * and pays nothing.
 *
 * Matching is by **label**, because that is the only identifier a shared `Field`
 * has. The server's diff labels come from the model's verbose_name (or the
 * curated editable-field registry), which is what form labels are written from,
 * so they line up. A miss simply means no marker — never a wrong one.
 */

export interface PendingMark {
  label: string
  to: string
  taskId: string
  taskTitle: string
  boardId: string
  due: string | null
}

const PendingFieldsContext = createContext<Map<string, PendingMark>>(new Map())

// "Position (U)" and "Position" are the same field: the registry label is the
// bare noun, form labels may carry a parenthetical unit — strip it to match.
const norm = (label: string) =>
  label
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase()

/** Mount on any page that renders an object's fields — an edit form, a detail
 *  Overview. Renders nothing itself. */
export function PendingFieldsProvider({
  objectType,
  objectId,
  boardHint,
  children,
}: {
  objectType: string
  objectId: string | undefined
  /** Board for the task links; the per-object payload carries the task only. */
  boardHint?: string
  children: ReactNode
}) {
  const planning = !!usePlanTarget()
  const changes = usePlannedChanges(objectType, objectId)
  const marks = useMemo(() => {
    const out = new Map<string, PendingMark>()
    // While *writing* a plan the banner already owns the context, and marking
    // the fields you are editing would be circular.
    if (planning) return out
    for (const c of changes) {
      for (const d of c.display ?? []) {
        const label = d.label || d.field
        out.set(norm(label), {
          label,
          to: d.to,
          taskId: c.task,
          taskTitle: "",
          boardId: boardHint ?? "",
          due: c.effective_date,
        })
      }
    }
    return out
  }, [changes, planning, boardHint])

  return (
    <PendingFieldsContext.Provider value={marks}>
      {children}
    </PendingFieldsContext.Provider>
  )
}

export function usePendingField(label: string): PendingMark | null {
  const marks = useContext(PendingFieldsContext)
  return marks.get(norm(label)) ?? null
}

/**
 * The marker itself: one small calendar-clock, explained on hover in the same
 * (i)-tip idiom the rest of the app uses. Renders nothing when the field has no
 * planned change, so `Field` and `KvCard` can drop it in unconditionally.
 */
export function PendingFieldMark({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  // Context only — no query hook here. `Field` renders this for every field in
  // the app, so an unmarked field must cost one useContext and nothing else
  // (and must not drag a QueryClient requirement into the shared form kit).
  const mark = usePendingField(label)
  if (!mark) return null
  return <MarkBody mark={mark} className={className} />
}

function MarkBody({
  mark,
  className,
}: {
  mark: PendingMark
  className?: string
}) {
  const { formatDate } = useDateFormat()
  return (
    <HoverCard openDelay={100} closeDelay={60}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="A change to this field is planned"
          className={`inline-flex items-center text-primary/80 transition-colors hover:text-primary ${className ?? ""}`}
        >
          <CalendarClock className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-64 space-y-1 text-xs leading-relaxed text-muted-foreground">
        <p>
          <span className="text-foreground">Change planned:</span>{" "}
          {mark.to || "cleared"}
          {mark.due ? ` · ${formatDate(mark.due)}` : ""}
        </p>
        <p>Editing this now may be overwritten when the plan is applied.</p>
        {mark.boardId && (
          <Link
            to="/planning/$boardId"
            params={{ boardId: mark.boardId }}
            search={{ task: mark.taskId }}
            className="link"
          >
            Open the task
          </Link>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
