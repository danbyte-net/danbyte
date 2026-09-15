import { EyeOff } from "lucide-react"

import { Button } from "@/components/ui/button"

/** The "N hidden · Show all" chip a map draws in a corner while things are
 * switched off - the reminder that the picture is not the whole inventory.
 * The sidebar carries the same count in its header when it is open; this is
 * for when it is not. */
export function HiddenChip({
  count,
  noun = "hidden",
  onShowAll,
}: {
  count: number
  /** "hidden" or "removed" - what the map calls it. */
  noun?: string
  onShowAll: () => void
}) {
  if (count <= 0) return null
  return (
    <div className="absolute right-3 bottom-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm">
      <EyeOff className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">
        <span className="num">{count}</span> {noun}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        onClick={onShowAll}
      >
        Show all
      </Button>
    </div>
  )
}
