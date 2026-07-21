import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import {
  api,
  type FloorPlan,
  type FloorPlanLiveState,
  type FloorPlanTile,
  type Paginated,
} from "@/lib/api"
import { FloorCanvas } from "@/components/floorplan/floor-canvas"

// Dashboard widget: a read-only, auto-fit view of your first floor plan with
// live tile status (monitoring rings + rack utilisation), and a link into the
// full editor. Polls /state/ so the status stays honest.
export function FloorplanWidget() {
  const plans = useQuery({
    queryKey: ["floor-plans", "widget"],
    queryFn: () => api<Paginated<FloorPlan>>("/api/floor-plans/?page_size=1"),
  })
  const plan = plans.data?.results?.[0]

  const tiles = useQuery({
    queryKey: ["floor-plan-tiles", plan?.id],
    queryFn: () =>
      api<Paginated<FloorPlanTile>>(
        `/api/floor-plan-tiles/?floor_plan=${plan!.id}&page_size=1000`
      ),
    enabled: !!plan,
  })
  const state = useQuery({
    queryKey: ["floor-plan-state", plan?.id],
    queryFn: () => api<FloorPlanLiveState>(`/api/floor-plans/${plan!.id}/state/`),
    enabled: !!plan,
    refetchInterval: 30_000,
  })

  if (plans.isLoading)
    return <div className="h-56 animate-pulse rounded-md bg-muted/30" />

  if (!plan)
    return (
      <div className="flex h-56 items-center justify-center rounded-md border border-dashed border-border p-4 text-center text-[13px] text-muted-foreground">
        <span>
          No floor plans yet —{" "}
          <Link to="/floorplans" className="text-primary hover:underline">
            create one
          </Link>
          .
        </span>
      </div>
    )

  return (
    <div className="relative h-56 overflow-hidden rounded-md border border-border bg-muted/20">
      <FloorCanvas
        plan={plan}
        tiles={tiles.data?.results ?? []}
        selectedId={null}
        editable={false}
        showGrid={false}
        armed={null}
        showFov={false}
        liveState={state.data ?? null}
        className="h-full w-full"
      />
      <div className="pointer-events-none absolute top-2 left-2 rounded-md border border-border bg-background/85 px-2 py-0.5 text-[11px] font-medium backdrop-blur">
        {plan.name}
      </div>
      <Link
        to="/floorplans/$id"
        params={{ id: plan.id }}
        className="absolute right-2 bottom-2 z-[5] rounded-md border border-border bg-background/85 px-2 py-1 text-[11px] backdrop-blur hover:bg-background"
        title="Open the full floor plan"
      >
        Open →
      </Link>
    </div>
  )
}
