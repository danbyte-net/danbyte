import { Link } from "@tanstack/react-router"
import { CalendarClock } from "lucide-react"

import { useDateFormat } from "@/lib/datetime"
import { usePlanTarget } from "@/lib/save-object"
import { usePlannedChanges } from "./planned-change-badge"

/** Warns an editor that someone has already planned changes to these fields.
 *
 * Two people can otherwise fight silently: an operator edits Description while a
 * task is holding a planned change to the same field, and whoever applies last
 * wins with no hint that the other existed. The notice names each field and its
 * planned value, so the editor can decide rather than discover.
 *
 * Hidden while *writing* a plan (the plan-mode banner already owns that context)
 * and when nothing is planned, so forms can mount it unconditionally. */
export function PendingChangesNotice({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string | undefined
}) {
  const planning = !!usePlanTarget()
  const changes = usePlannedChanges(objectType, objectId)
  const { formatDate } = useDateFormat()
  if (planning || changes.length === 0) return null

  const lines = changes.flatMap((c) =>
    (c.display ?? []).map((d) => ({
      key: `${c.id}-${d.field}`,
      label: d.label || d.field,
      to: d.to,
      due: c.effective_date,
      task: c.task,
    }))
  )

  return (
    <div className="mb-4 space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
        {lines.length} change{lines.length === 1 ? "" : "s"} already planned for
        this object
      </p>
      <ul className="space-y-0.5 pl-6">
        {lines.map((l) => (
          <li key={l.key} className="text-[12px] text-muted-foreground">
            <span className="text-foreground">{l.label}</span> → {l.to || "—"}
            {l.due ? ` · ${formatDate(l.due)}` : ""}
          </li>
        ))}
      </ul>
      <p className="pl-6 text-[12px] text-muted-foreground">
        Editing those fields here writes immediately and may be overwritten when
        the plan is applied.{" "}
        <Link
          to="/planning"
          className="text-primary hover:underline"
          search={{}}
        >
          Open Planning
        </Link>
      </p>
    </div>
  )
}
