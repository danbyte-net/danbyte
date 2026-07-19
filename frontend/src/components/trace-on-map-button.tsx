import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Waypoints } from "lucide-react"

import { api } from "@/lib/api"
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
