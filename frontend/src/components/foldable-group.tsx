import { useState } from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A foldable list group — header with an optional leading badge, name, count
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
  /** Leading swatch/icon — e.g. the floorplan's TileBadge, or a status dot. */
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

/** Monitoring worst-status → dot colour class; shared by map + floorplan
 *  sidebars so a "down" reads identically everywhere. */
export const CHECK_TONE: Record<string, string> = {
  up: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
  stale: "bg-zinc-400",
  unknown: "bg-zinc-400",
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
