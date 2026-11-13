import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type { FloorPlan, Paginated } from "@/lib/api"
import { PlanView } from "@/components/floorplan/plan-view"
import { FormCombobox } from "@/components/forms"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Dashboard widget: a read-only view of a floor plan as its page draws it
// for a viewer - the plan's saved Display settings, walls, areas, labels,
// trays and cables, live tile status polled every 30s (PlanView) - fitted
// to its content, with a link into the full plan. Which plan is a
// per-instance setting - the widget can be placed several times, one per
// floor - falling back to the first plan when unset.
export function FloorplanWidget({
  planId,
  editing,
  onPlanChange,
}: {
  planId?: string
  editing?: boolean
  onPlanChange?: (id: string) => void
}) {
  // The widget draws one plan: the picked one by id (the plan page's own
  // query, so the two share it), else the first. Every plan is read only
  // while editing, for the picker - not a hundred plans on each page load.
  const picked = useQuery({
    queryKey: ["floor-plan", planId],
    queryFn: () => api<FloorPlan>(`/api/floor-plans/${planId}/`),
    enabled: !!planId,
  })
  const list = editing || !planId || picked.isError
  const plans = useQuery({
    queryKey: ["floor-plans", "widget-list", editing ? "all" : "first"],
    queryFn: () =>
      api<Paginated<FloorPlan>>(
        `/api/floor-plans/?page_size=${editing ? 100 : 1}`
      ),
    enabled: list,
  })
  const all = plans.data?.results ?? []
  const plan =
    picked.data ?? ((planId && all.find((x) => x.id === planId)) || all[0])

  if (planId ? picked.isLoading || (list && plans.isLoading) : plans.isLoading)
    return (
      <div className="h-full min-h-40 animate-pulse rounded-md bg-muted/30" />
    )

  if (!plan)
    return (
      <div className="flex h-full min-h-40 items-center justify-center rounded-md border border-dashed border-border p-4 text-center text-[13px] text-muted-foreground">
        <span>
          No floor plans yet -{" "}
          <Link to="/floorplans" className="link">
            create one
          </Link>
          .
        </span>
      </div>
    )

  return (
    <div className="flex h-full min-h-40 flex-col gap-2">
      {editing && onPlanChange && all.length > 1 && (
        <FormCombobox
          label="Floor plan"
          value={plan?.id ?? null}
          onChange={(v) => v && onPlanChange(v)}
          options={all.map((x) => ({ value: x.id, label: x.name }))}
          searchPlaceholder="Search floor plans…"
          emptyText="No floor plans."
        />
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/20">
        <PlanView id={plan.id} />
        <div className="pointer-events-none absolute top-2 left-2 z-[15] rounded-md border border-border bg-background/85 px-2 py-0.5 text-[11px] font-medium backdrop-blur">
          {plan.name}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/floorplans/$id"
              params={{ id: plan.id }}
              className="absolute right-2 bottom-2 z-[15] rounded-md border border-border bg-background/85 px-2 py-1 text-[11px] backdrop-blur hover:bg-background"
            >
              Open →
            </Link>
          </TooltipTrigger>
          <TooltipContent>Open the full floor plan</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
