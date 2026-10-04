import { InfoTip } from "@/components/ui/info-tip"
import { cn } from "@/lib/utils"

/** The word on a map too large to open whole: the camera shows a part of
 * it. A chip on the canvas: bordered, no shadow. */
export function PartialMapChip({
  side = "bottom",
  className,
}: {
  /** Where its tip opens: away from the canvas edge it sits on. */
  side?: "top" | "bottom"
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md border border-border bg-background/95 px-2 py-1 text-xs whitespace-nowrap text-muted-foreground",
        className
      )}
    >
      Partial map
      <InfoTip side={side}>
        Part of a large map. Search or focus a device to see the rest.
      </InfoTip>
    </div>
  )
}
