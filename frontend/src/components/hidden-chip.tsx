import type { ReactNode } from "react"
import { EyeOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Which corner of the map the chip sits in - whichever one the page's own
 * furniture (a MiniMap, a legend, the tile attribution) leaves free - or
 * `inline`, in a bar among its controls. */
export type HiddenChipPosition =
  "bottom-right" | "bottom-left" | "top-right" | "top-left" | "inline"

const POSITION: Record<HiddenChipPosition, string> = {
  "bottom-right": "absolute right-3 bottom-3",
  "bottom-left": "absolute bottom-3 left-3",
  "top-right": "absolute top-3 right-3",
  "top-left": "absolute top-3 left-3",
  inline: "h-7 shrink-0 py-0",
}

/** The "N hidden · Show all" chip a map draws in a corner while things are
 * switched off - the reminder that the picture is not the whole inventory.
 * The Objects sidebar carries the same count and button when it is open;
 * this is for when it is not. A floor plan's filter wears it in its bar:
 * what the filter keeps, and Clear. */
export function HiddenChip({
  count,
  noun = "hidden",
  position = "bottom-right",
  className,
  onShowAll,
  label,
  icon,
  action = "Show all",
}: {
  count: number
  /** "hidden" or "removed" - what the map calls it. */
  noun?: string
  position?: HiddenChipPosition
  /** Extra placement, e.g. a z-index above the map's own layers. */
  className?: string
  onShowAll: () => void
  /** Says it instead of "N hidden" (shown whatever the count). */
  label?: ReactNode
  icon?: ReactNode
  /** The button's word. */
  action?: string
}) {
  if (label == null && count <= 0) return null
  return (
    <div
      className={cn(
        "z-10 flex items-center gap-2 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs",
        POSITION[position],
        className
      )}
    >
      {icon ?? <EyeOff className="size-3.5 text-muted-foreground" />}
      <span className="min-w-0 truncate text-muted-foreground">
        {label ?? (
          <>
            <span className="num">{count}</span> {noun}
          </>
        )}
      </span>
      <Button
        size="xs"
        variant={position === "inline" ? "ghost" : "outline"}
        onClick={onShowAll}
      >
        {action}
      </Button>
    </div>
  )
}
