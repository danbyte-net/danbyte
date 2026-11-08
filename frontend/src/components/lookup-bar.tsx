import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/** What one possible value means. `neutral` for a value with no verdict. */
export type LookupTone = "ok" | "warning" | "error" | "neutral"

export interface LookupState {
  /** Identifies the state; compared with `current`. */
  key: string
  label: string
  tone: LookupTone
}

// The status families the Badge variants use - one red, one amber, one
// green across the product. Never the accent.
const TONE_FILL: Record<LookupTone, string> = {
  ok: "bg-emerald-500 dark:bg-emerald-400",
  warning: "bg-amber-500 dark:bg-amber-400",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/60",
}

/**
 * A segmented state bar: one segment per value a lookup can take, in order,
 * with the current one filled in the colour of what it means and the others
 * as quiet track. The current value's label sits underneath; each segment
 * names its value in the shared tooltip.
 *
 * Shared: the PRTG sensor panel draws lookup channels with it ("Root
 * authority trusted: Yes / No"), and any Danbyte check with a fixed set of
 * outcomes can hand it its states and the current one.
 */
export function LookupBar({
  states,
  current,
  label,
  className,
}: {
  states: LookupState[]
  current: string | null | undefined
  /** Shown under the bar instead of the current state's label - PRTG's own
   * text for the value, say. */
  label?: string
  className?: string
}) {
  const now = states.find((s) => s.key === current)
  const text = label || now?.label || "No data"
  return (
    <div className={cn("w-full min-w-0", className)}>
      <div
        className="flex h-2.5 gap-0.5 overflow-hidden rounded-md"
        role="img"
        aria-label={`${text} (${states.map((s) => s.label).join(", ")})`}
      >
        {states.map((s) => {
          const on = s.key === current
          return (
            <Tooltip key={s.key}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "h-full min-w-2 flex-1",
                    on ? TONE_FILL[s.tone] : "bg-muted"
                  )}
                  data-current={on || undefined}
                  data-tone={s.tone}
                />
              </TooltipTrigger>
              <TooltipContent variant="default">{s.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <p
        className={cn(
          "mt-1.5 truncate text-sm font-medium",
          !now && "text-muted-foreground"
        )}
      >
        {text}
      </p>
    </div>
  )
}
