import {
  CAPACITY_BAR_CLASS,
  capacityLevel,
  useCapacityThresholds,
} from "@/lib/rack-capacity"
import { cn } from "@/lib/utils"

/**
 * The thin capacity bar: a muted track filled to the ratio in its level's
 * status colour (`lib/rack-capacity.ts`). With nothing to measure against
 * (`ratio` null) the track stays empty. Rack space and power use it; IPAM
 * prefixes keep `UtilCell`.
 */
export function CapacityBar({
  ratio,
  className,
}: {
  ratio: number | null
  /** Track size - `w-16` unless the slot needs another. */
  className?: string
}) {
  const thresholds = useCapacityThresholds()
  const level = ratio != null ? capacityLevel(ratio, thresholds) : null
  return (
    <span
      aria-hidden
      data-slot="capacity-bar"
      className={cn(
        "block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted",
        className
      )}
    >
      {ratio != null && level && (
        <span
          data-level={level}
          className={cn("block h-full rounded-full", CAPACITY_BAR_CLASS[level])}
          style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
        />
      )}
    </span>
  )
}
