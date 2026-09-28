import { EyeOff, Search } from "lucide-react"

import {
  statusLabel,
  useStatusLabels,
} from "@/components/monitoring/status-palette"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// The Objects sidebar every Maps page opens on its right: the topology map,
// the site map and a floor plan. One title, one search box, one status
// filter and one "N hidden · Show all" row, so the three lists are the same
// tool with different contents. The pages own their sections; FoldableGroup
// (foldable-group.tsx) folds the groups inside them.

/** The monitoring states the sidebar filters by; null is All. */
export type CheckFilter = "down" | "degraded" | "up" | null

const FILTER_STATES = ["down", "degraded", "up"] as const

/** Per-state counts for the filter's tabs, from each listed object's check. */
export function checkCounts(
  checks: Iterable<string | null | undefined>
): Record<(typeof FILTER_STATES)[number], number> {
  const out = { down: 0, degraded: 0, up: 0 }
  for (const c of checks)
    if (c === "down" || c === "degraded" || c === "up") out[c] += 1
  return out
}

/** All · Down · Degraded · Up, named as the tenant names the states, each
 * with how many objects are in it. */
export function CheckFilterTabs({
  value,
  onChange,
  counts,
  className,
}: {
  value: CheckFilter
  onChange: (value: CheckFilter) => void
  counts: Partial<Record<(typeof FILTER_STATES)[number], number>>
  className?: string
}) {
  const labels = useStatusLabels()
  return (
    <SegmentedTabs<"all" | (typeof FILTER_STATES)[number]>
      // A tighter pad than a page's tabs so four fit the sidebar's width;
      // `wrap` takes a long tenant name onto a second row instead of
      // scrolling it out of sight.
      wrap
      className={cn("[&>button]:px-2", className)}
      value={value ?? "all"}
      onValueChange={(v) => onChange(v === "all" ? null : v)}
      items={[
        { value: "all", label: "All" },
        ...FILTER_STATES.map((s) => ({
          value: s,
          label: statusLabel(s, labels),
          count: counts[s] || null,
        })),
      ]}
    />
  )
}

/** A section heading inside the sidebar: "Problems", "Devices", "Links"… */
export function ObjectsSection({
  heading,
  action,
  children,
}: {
  heading: string
  /** Trailing control on the heading row, e.g. a grouping switch. */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex min-h-5 items-center gap-2 px-1">
        <p className="text-[10px] font-semibold tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase">
          {heading}
        </p>
        {action && <div className="ml-auto flex items-center">{action}</div>}
      </div>
      {children}
    </div>
  )
}

/**
 * The sidebar itself: "Objects" and its count, the search box, the status
 * filter, the hidden row, then the page's sections as children.
 */
export function ObjectsPanel({
  ref,
  total,
  query,
  onQueryChange,
  onSearchEnter,
  status,
  onStatusChange,
  statusCounts,
  hiddenCount,
  onShowAll,
  children,
}: {
  /** The panel is the scroller; a lazily drawn list measures against it. */
  ref?: React.Ref<HTMLElement>
  /** Everything the list shows now, after search and filter. */
  total: number
  query: string
  onQueryChange: (q: string) => void
  /** Enter in the search box - a page jumps to its first hit. */
  onSearchEnter?: () => void
  status: CheckFilter
  onStatusChange: (status: CheckFilter) => void
  statusCounts: Partial<Record<(typeof FILTER_STATES)[number], number>>
  hiddenCount: number
  /** Omit where nothing can be hidden: the row never shows. */
  onShowAll?: () => void
  children: React.ReactNode
}) {
  return (
    <aside
      ref={ref}
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Objects
        </p>
        <span className="num text-[11px] text-muted-foreground">{total}</span>
      </div>
      <div className="relative mb-2">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSearchEnter?.()
          }}
          placeholder="Search…"
          aria-label="Search objects"
          className="h-8 pl-7 text-[13px]"
        />
      </div>
      <CheckFilterTabs
        className="mb-3"
        value={status}
        onChange={onStatusChange}
        counts={statusCounts}
      />
      {onShowAll && hiddenCount > 0 && (
        <div className="mb-3 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <EyeOff className="size-3 shrink-0" />
          <span>
            <span className="num">{hiddenCount}</span> hidden
          </span>
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={onShowAll}
          >
            Show all
          </Button>
        </div>
      )}
      {children}
    </aside>
  )
}

/** The empty line under the filters: nothing matched, or nothing is there. */
export function ObjectsEmpty({ filtered }: { filtered: boolean }) {
  return (
    <p className="px-1 text-[13px] text-muted-foreground">
      {filtered ? "No matches." : "No objects yet."}
    </p>
  )
}
