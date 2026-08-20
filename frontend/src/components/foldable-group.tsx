import { useState } from "react"
import { ChevronDown } from "lucide-react"

import { CHECK_TONE } from "@/components/site-map/status-colors"
import { cn } from "@/lib/utils"

/**
 * A foldable list group - header with an optional leading badge, name, count
 * and a chevron that rotates -90 when closed. Extracted from the floorplan
 * objects sidebar so the site map's sidebar folds look identical.
 */
export function FoldableGroup({
  title,
  badge,
  count,
  defaultOpen = true,
  children,
}: {
  title: string
  /** Leading swatch/icon - e.g. the floorplan's TileBadge, or a status dot. */
  badge?: React.ReactNode
  count: number
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px] font-medium hover:bg-muted/60"
      >
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90"
          )}
        />
        {badge}
        <span className="truncate">{title}</span>
        <span className="num ml-auto text-[11px] text-muted-foreground/70">
          {count}
        </span>
      </button>
      {open && <div className="mb-1 flex flex-col">{children}</div>}
    </div>
  )
}

/** Monitoring worst-status → dot colour class; re-exported from the shared
 *  status palette so map, MiniMap and sidebars can't drift apart. */
export { CHECK_TONE }

/** Mini status badge - the Badge primitive's semantic tints at list-row
 *  scale, showing the status word itself. Friendlier than a bare dot. */
const CHECK_CHIP: Record<string, string> = {
  up: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  degraded: "bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  down: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  stale: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
}

export function CheckChip({ check }: { check: string | null | undefined }) {
  if (!check) return null
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[4px] px-1 text-[10px] font-medium",
        CHECK_CHIP[check] ?? CHECK_CHIP.unknown
      )}
      title={`Monitoring: ${check}`}
    >
      {check}
    </span>
  )
}

export function CheckDot({ check }: { check: string | null | undefined }) {
  if (!check) return null
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        CHECK_TONE[check] ?? "bg-zinc-400"
      )}
      title={`Monitoring: ${check}`}
    />
  )
}
