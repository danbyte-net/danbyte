import { EyeOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Which corner of the map the chip sits in - whichever one the page's own
 * furniture (a MiniMap, a legend, the tile attribution) leaves free. */
export type HiddenChipPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left"

const POSITION: Record<HiddenChipPosition, string> = {
  "bottom-right": "right-3 bottom-3",
  "bottom-left": "bottom-3 left-3",
  "top-right": "top-3 right-3",
  "top-left": "top-3 left-3",
}

/** The "N hidden · Show all" chip a map draws in a corner while things are
 * switched off - the reminder that the picture is not the whole inventory.
 * The Objects sidebar carries the same count and button when it is open;
 * this is for when it is not. */
export function HiddenChip({
  count,
  noun = "hidden",
  position = "bottom-right",
  className,
  onShowAll,
}: {
  count: number
  /** "hidden" or "removed" - what the map calls it. */
  noun?: string
  position?: HiddenChipPosition
  /** Extra placement, e.g. a z-index above the map's own layers. */
  className?: string
  onShowAll: () => void
}) {
  if (count <= 0) return null
  return (
    <div
      className={cn(
        "absolute z-10 flex items-center gap-2 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs",
        POSITION[position],
        className
      )}
    >
      <EyeOff className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">
        <span className="num">{count}</span> {noun}
      </span>
      <Button size="xs" variant="outline" onClick={onShowAll}>
        Show all
      </Button>
    </div>
  )
}
