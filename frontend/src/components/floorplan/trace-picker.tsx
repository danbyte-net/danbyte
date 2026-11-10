import { X } from "lucide-react"

import { Field } from "@/components/forms/field"
import { Badge } from "@/components/ui/badge"
import { MultiCombobox } from "@/components/ui/multi-combobox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { CableScheduleEnd, CableScheduleRow } from "@/lib/api"

/** Trace pages a schedule PDF or report may have (MAX_TRACES). */
export const MAX_TRACES = 20

function ends(es: readonly CableScheduleEnd[]): string {
  return es
    .map((e) =>
      e.hidden ? "Hidden" : [e.device, e.port].filter(Boolean).join(" · ")
    )
    .filter(Boolean)
    .join(", ")
}

/** A cable's line in the picker: its label, then A → B. */
export function traceOption(r: CableScheduleRow): string {
  const a = ends(r.a)
  const b = ends(r.b)
  return a || b ? `${r.label} · ${a || "-"} → ${b || "-"}` : r.label
}

/**
 * The cables to give a trace page each: picked from the schedule's own
 * rows (so only cables it lists - the server checks again), several at a
 * time, at most {@link MAX_TRACES}; the picked ones as chips to remove.
 */
export function TracePicker({
  rows,
  value,
  onChange,
  disabled,
}: {
  /** The schedule's rows; undefined while they load. */
  rows: readonly CableScheduleRow[] | undefined
  value: readonly string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const picked = new Set(value)
  const byId = new Map((rows ?? []).map((r) => [r.id, r]))
  const left = MAX_TRACES - value.length
  return (
    <div className="grid gap-1.5">
      <Field label="Cables to trace" labelHidden>
        <MultiCombobox
          options={(rows ?? [])
            .filter((r) => !picked.has(r.id))
            .map((r) => ({ value: r.id, label: traceOption(r) }))}
          onAdd={(more) =>
            onChange(
              [...value, ...more.map((m) => m.value)].slice(0, MAX_TRACES)
            )
          }
          max={Math.max(0, left)}
          disabled={disabled || !rows || left <= 0}
          placeholder={rows ? "Pick cables…" : "Loading…"}
          searchPlaceholder="Search cables…"
          emptyText="No cables."
          className="text-[13px]"
        />
      </Field>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1" data-part="trace-picked">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1">
              {byId.get(id)?.label ?? "Cable"}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="opacity-80 hover:opacity-100"
                    aria-label="Remove"
                    onClick={() => onChange(value.filter((x) => x !== id))}
                  >
                    <X className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" variant="default">
                  Remove
                </TooltipContent>
              </Tooltip>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
