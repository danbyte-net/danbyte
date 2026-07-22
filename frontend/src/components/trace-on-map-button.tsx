import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Route as RouteIcon, Waypoints } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"

/**
 * "Trace on map" — jumps to the floor plan that shows this cable, with its
 * A↔B route highlighted and the view fitted to it (no Cables-mode clicking).
 * Renders nothing when the cable isn't on any plan.
 */
export function TraceOnMapButton({ cableId }: { cableId: string }) {
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cable-floor-plan", cableId],
    queryFn: () =>
      api<{ plan_id: string | null }>(`/api/cables/${cableId}/floor-plan/`),
  })
  const planId = q.data?.plan_id
  if (!planId) return null
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        nav({
          to: "/floorplans/$id",
          params: { id: planId },
          search: { trace: cableId },
        })
      }
    >
      <Waypoints className="h-3.5 w-3.5" /> Trace on map
    </Button>
  )
}

/**
 * "Auto-route" — asks the server to compute the best tray path for this cable
 * on its floor plan, assign those trays, and estimate the length (run +
 * vertical drops + slack; an already-recorded length is kept). Renders nothing
 * when the cable's ends aren't on any plan or the user can't edit cables.
 */
export function AutoRouteButton({ cableId }: { cableId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const q = useQuery({
    queryKey: ["cable-floor-plan", cableId],
    queryFn: () =>
      api<{ plan_id: string | null }>(`/api/cables/${cableId}/floor-plan/`),
  })
  const planId = q.data?.plan_id
  const route = useMutation({
    mutationFn: () =>
      api<{
        reachable: boolean
        detail?: string
        tray_names: string[]
        length_m: number
        length_set: boolean
      }>(`/api/cables/${cableId}/auto-route/`, {
        method: "POST",
        body: JSON.stringify({ floor_plan: planId }),
      }),
    onSuccess: (r) => {
      if (!r.reachable) {
        toast.info(r.detail ?? "No tray path connects the two ends.")
        return
      }
      qc.invalidateQueries({ queryKey: ["cable", cableId] })
      qc.invalidateQueries({ queryKey: ["cable-floor-plan", cableId] })
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths"] })
      toast.success(
        `Routed via ${r.tray_names.join(" → ")} · est. ${r.length_m} m` +
          (r.length_set ? "" : " (recorded length kept)")
      )
    },
    onError: (err) => apiErrorToast(err),
  })
  if (!planId || !canDo("cable", "change")) return null
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={route.isPending}
      title="Compute the best tray path, assign the trays, estimate the length"
      onClick={() => route.mutate()}
    >
      <RouteIcon className="h-3.5 w-3.5" />
      {route.isPending ? "Routing…" : "Auto-route"}
    </Button>
  )
}

/**
 * "Show on site map" — jumps to the geographic map with this cable drawn
 * along its assigned routes and highlighted. Renders nothing when the cable
 * isn't assigned to any route.
 */
export function TraceOnSiteMapButton({ cableId }: { cableId: string }) {
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["cable-routes", "of-cable", cableId],
    queryFn: () =>
      api<{ count: number }>(`/api/cable-routes/?cable=${cableId}&page_size=1`),
  })
  if (!q.data?.count) return null
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => nav({ to: "/site-map", search: { trace: cableId } })}
    >
      <Waypoints className="h-3.5 w-3.5" /> Show on site map
    </Button>
  )
}
