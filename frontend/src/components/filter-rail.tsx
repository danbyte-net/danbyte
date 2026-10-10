import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { EyeOff } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ColorBadge } from "@/components/cells/color-badge"
import { cn } from "@/lib/utils"

// Shared filter-rail building blocks. Every list page uses these:
//
//   <FilterRail>
//     <FacetGroup label="Status" options={...} selected={...} onToggle={...} />
//     ...children
//   </FilterRail>
//
// Adding a new list page = drop FilterRail + N FacetGroups in the aside.

export interface FacetOption {
  value: string
  label: string
  count: number
  /** Optional swatch color. When set, the label renders as a colored chip. */
  color?: string
  textColor?: string
}

// Toggles one value in/out of a Set without mutating the original.
export function toggleInSet<T>(
  current: Set<T>,
  value: T,
  setter: (s: Set<T>) => void
) {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  setter(next)
}

// ─── Hidden facets (#285) ───────────────────────────────────────────────
//
// A user can hide whole facets on a list they never filter by. The list
// shell provides where that is stored (a per-list pref, like column
// layouts); without a provider - an embedded rail, a test - nothing is
// hideable and every facet shows. A hidden facet that still has a selection
// keeps showing, so no filter ever applies out of sight.

export interface FacetVisibility {
  hidden: string[]
  setHidden: (hidden: string[]) => void
}

const FacetVisibilityContext = createContext<FacetVisibility | null>(null)

export const FacetVisibilityProvider = FacetVisibilityContext.Provider

/** Labels of the facets on the current rail, so the rail can name the
 * hidden ones it offers to show again. */
const FacetLabelsContext = createContext<
  ((id: string, label: string) => void) | null
>(null)

function useFacetVisible(id: string, label: string, active: boolean) {
  const vis = useContext(FacetVisibilityContext)
  const register = useContext(FacetLabelsContext)
  useEffect(() => {
    register?.(id, label)
  }, [register, id, label])
  const hidden = !!vis?.hidden.includes(id) && !active
  const onHide = vis
    ? () => vis.setHidden([...vis.hidden.filter((h) => h !== id), id])
    : undefined
  return { hidden, onHide }
}

/** A facet's heading row: its name, a "clear" when it has a selection, and
 * a hide control when the list can store one. */
export function FacetHeading({
  label,
  onClear,
  onHide,
}: {
  label: string
  onClear?: () => void
  onHide?: () => void
}) {
  return (
    <div className="group/facet mb-1.5 flex items-center gap-1.5">
      <h3 className="text-[10px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">
        {label}
      </h3>
      {onHide && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Hide ${label}`}
              onClick={onHide}
              className="text-muted-foreground opacity-0 group-hover/facet:opacity-100 hover:text-foreground focus-visible:opacity-100"
            >
              <EyeOff className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" variant="default">
            Hide filter
          </TooltipContent>
        </Tooltip>
      )}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
        >
          clear
        </button>
      )}
    </div>
  )
}

/** Wraps one facet so it can be hidden. Render the facet as `children(onHide)`
 * - null while hidden. */
export function HideableFacet({
  id,
  label,
  active,
  children,
}: {
  id: string
  label: string
  /** Has a selection - stays visible even when hidden. */
  active: boolean
  children: (onHide?: () => void) => React.ReactNode
}) {
  const { hidden, onHide } = useFacetVisible(id, label, active)
  if (hidden) return null
  return <>{children(onHide)}</>
}

export function FilterRail({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const vis = useContext(FacetVisibilityContext)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const register = useMemo(
    () => (id: string, label: string) =>
      setLabels((l) => (l[id] === label ? l : { ...l, [id]: label })),
    []
  )
  // Only facets this rail renders: a stored id for a facet the list no
  // longer has is not offered back.
  const hiddenHere = (vis?.hidden ?? []).filter((id) => id in labels)
  return (
    <aside
      className={cn(
        "hidden h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-background p-4 lg:flex",
        className
      )}
    >
      <FacetLabelsContext.Provider value={register}>
        {children}
      </FacetLabelsContext.Provider>
      {vis && hiddenHere.length > 0 && (
        <div className="mt-auto border-t border-border pt-2">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            Hidden filters
          </div>
          <div className="flex flex-wrap gap-1">
            {hiddenHere.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() =>
                  vis.setHidden(vis.hidden.filter((h) => h !== id))
                }
                className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {labels[id]}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}

/** Above this many options a facet gets a search box and shows only the
 * first {@link FACET_TOP} until "Show all". */
export const FACET_SEARCH_MIN = 10
export const FACET_TOP = 8

export interface FacetGroupProps {
  label: string
  options: FacetOption[]
  selected: Set<string>
  onToggle: (v: string) => void
  /** Stable id for hiding this facet; defaults to the label. */
  facetId?: string
}

export function FacetGroup({
  label,
  options,
  selected,
  onToggle,
  facetId,
}: FacetGroupProps) {
  if (options.length === 0) return null
  return (
    <HideableFacet
      id={facetId ?? label}
      label={label}
      active={selected.size > 0}
    >
      {(onHide) => (
        <FacetList
          label={label}
          options={options}
          selected={selected}
          onToggle={onToggle}
          onHide={onHide}
        />
      )}
    </HideableFacet>
  )
}

function FacetList({
  label,
  options,
  selected,
  onToggle,
  onHide,
}: FacetGroupProps & { onHide?: () => void }) {
  const [q, setQ] = useState("")
  const [all, setAll] = useState(false)
  const long = options.length > FACET_SEARCH_MIN
  const needle = q.trim().toLowerCase()
  const matching = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle))
    : options
  // Options arrive most-used first. A ticked option beyond the cut always
  // shows, so a selection is never out of sight.
  const shown =
    !long || all || needle
      ? matching
      : matching.filter((o, i) => i < FACET_TOP || selected.has(o.value))
  const more = matching.length - shown.length
  return (
    <div>
      <FacetHeading
        label={label}
        onHide={onHide}
        onClear={
          selected.size > 0
            ? () => selected.forEach((v) => onToggle(v))
            : undefined
        }
      />
      {long && (
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          aria-label={`Search ${label}`}
          className="mb-1 h-7 px-2 text-xs"
        />
      )}
      <ul className="space-y-0.5">
        {shown.map((opt) => (
          <li key={opt.value}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
              <Checkbox
                checked={selected.has(opt.value)}
                onCheckedChange={() => onToggle(opt.value)}
                aria-label={opt.label}
              />
              {opt.color ? (
                <ColorBadge name={opt.label} color={opt.color} />
              ) : (
                <span className="flex-1">{opt.label}</span>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {opt.count}
              </span>
            </label>
          </li>
        ))}
        {needle && matching.length === 0 && (
          <li className="px-1.5 py-1 text-xs text-muted-foreground">
            No matches
          </li>
        )}
      </ul>
      {long && !needle && (more > 0 || all) && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="mt-0.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {all ? "Show fewer" : `Show all ${matching.length}`}
        </button>
      )}
    </div>
  )
}
