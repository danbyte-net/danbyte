import {
  CABLE_STATE_LABEL,
  CABLE_STATES,
  type CableState,
} from "@/lib/cable-state"
import { cn } from "@/lib/utils"

/** The cabled-state chip row for port tables - All · connected · reserved ·
 * undocumented · free. Same visual as the map sidebar's status chips. */
export function CabledFilterChips({
  value,
  onChange,
  counts,
}: {
  value: CableState | null
  onChange: (v: CableState | null) => void
  /** Per-state row counts; states with 0 rows still render (so an incoming
   * deep link's active chip is always visible). */
  counts?: Partial<Record<CableState, number>>
}) {
  const options: [CableState | null, string][] = [
    [null, "All"],
    ...CABLE_STATES.map(
      (s) => [s, CABLE_STATE_LABEL[s]] as [CableState, string]
    ),
  ]
  return (
    <div className="flex items-center gap-1">
      {options.map(([v, label]) => (
        <button
          key={label}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            "rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium",
            value === v
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:text-foreground"
          )}
        >
          {label}
          {v !== null && counts?.[v] !== undefined && (
            <span className="num ml-1 opacity-70">{counts[v]}</span>
          )}
        </button>
      ))}
    </div>
  )
}
