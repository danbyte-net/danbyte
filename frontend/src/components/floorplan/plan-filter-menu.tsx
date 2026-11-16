import { useMemo } from "react"
import { ListFilter } from "lucide-react"

import type { FloorPlanTile } from "@/lib/api"
import { FacetGroup } from "@/components/filter-rail"
import { ExpressionFilter } from "@/components/filter-expression"
import { HiddenChip } from "@/components/hidden-chip"
import { BarMenuTrigger } from "@/components/map-toolbar"
import { SavedViews } from "@/components/saved-views"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"

import {
  FILTER_DIMS,
  FILTER_LABELS,
  NO_FILTER,
  PLAN_VIEW_TYPE,
  areaIndex,
  facetOptions,
  filterCount,
  filterIsOn,
  filterRow,
  filterSnapshot,
  filterSummary,
  readPlanFilter,
  toggleFacet,
} from "./plan-filter"
import type { PlanFilter } from "./plan-filter"
import type { AreaShape } from "./shapes"

/** The floor plan bar's Filter ▾, its saved Views and, while a filter is
 * on, the chip that says what it keeps with Clear. The facets are the
 * list pages' (FacetGroup), the advanced expression theirs too
 * (ExpressionFilter), and a view saves like a list's, under the
 * `floorplan` object type. */
export function PlanFilterMenu({
  filter,
  onChange,
  tiles,
  areas,
  kept,
}: {
  filter: PlanFilter
  onChange: (next: PlanFilter) => void
  /** The tiles on show (what the facets count). */
  tiles: readonly FloorPlanTile[]
  areas: readonly AreaShape[]
  /** How many tiles the filter keeps (null while it is off). */
  kept: number | null
}) {
  const options = useMemo(
    () => facetOptions(tiles, areas, filter),
    [tiles, areas, filter]
  )
  const rows = useMemo(() => {
    const idx = areaIndex(areas)
    return tiles.map((t) => filterRow(t, idx))
  }, [tiles, areas])
  const count = filterCount(filter)
  const on = filterIsOn(filter)
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <BarMenuTrigger aria-label="Filter the plan">
            <ListFilter /> Filter
            {count > 0 && (
              <Badge variant="secondary" className="num h-4 px-1 text-[10px]">
                {count}
              </Badge>
            )}
          </BarMenuTrigger>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="max-h-[min(32rem,70vh)] space-y-4 overflow-y-auto p-3">
            {FILTER_DIMS.map((d) => (
              <FacetGroup
                key={d}
                facetId={`plan-${d}`}
                label={FILTER_LABELS[d]}
                options={options[d]}
                selected={new Set(filter.facets[d] ?? [])}
                onToggle={(v) => onChange(toggleFacet(filter, d, v))}
              />
            ))}
            <ExpressionFilter
              value={filter.expr}
              rows={rows}
              onChange={(expr) => onChange({ ...filter, expr })}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-border p-2.5">
            <Switch
              id="plan-filter-hide"
              checked={filter.hide}
              onCheckedChange={(hide) => onChange({ ...filter, hide })}
            />
            <Label htmlFor="plan-filter-hide" className="text-xs font-normal">
              Hide others
            </Label>
            {on && (
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto text-muted-foreground"
                onClick={() => onChange(NO_FILTER)}
              >
                Clear
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <SavedViews
        objectType={PLAN_VIEW_TYPE}
        q=""
        onQ={() => {}}
        compact
        emptyHint="No saved views yet. Filter the plan - only the access points, say - then save it as a view."
        filterFirstHint="Filter the plan first"
        filters={{
          snapshot: () => filterSnapshot(filter),
          restore: (s) => onChange(readPlanFilter(s)),
          activeCount: count,
        }}
      />
      {on && (
        <HiddenChip
          position="inline"
          count={kept ?? 0}
          icon={<ListFilter className="size-3.5 text-muted-foreground" />}
          label={
            <>
              {filterSummary(filter, options)} ·{" "}
              <span className="num">{kept ?? 0}</span> shown
            </>
          }
          action="Clear"
          className="max-w-72"
          onShowAll={() => onChange(NO_FILTER)}
        />
      )}
    </>
  )
}
