import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { LayoutGrid } from "lucide-react"

import { api } from "@/lib/api"
import type { FloorPlanTile, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"

/**
 * "Show on floor plan" — links to the plan where this rack/device is placed.
 * For a device, falls back to its rack's placement ("via rack") when the
 * device itself isn't tiled. Renders nothing when nothing is placed.
 */
export function ShowOnFloorPlan({
  deviceId,
  rackId,
}: {
  deviceId?: string
  rackId?: string
}) {
  const deviceQ = useQuery({
    queryKey: ["floor-tile-placement", "device", deviceId],
    queryFn: () =>
      api<Paginated<FloorPlanTile>>(
        `/api/floor-plan-tiles/?device=${deviceId}`
      ),
    enabled: !!deviceId,
  })
  const rackQ = useQuery({
    queryKey: ["floor-tile-placement", "rack", rackId],
    queryFn: () =>
      api<Paginated<FloorPlanTile>>(`/api/floor-plan-tiles/?rack=${rackId}`),
    enabled: !!rackId,
  })

  const deviceTile = deviceQ.data?.results[0]
  const rackTile = rackQ.data?.results[0]
  const tile = deviceTile ?? rackTile
  if (!tile?.floor_plan) return null
  const viaRack = !deviceTile && !!rackTile

  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/floorplans/$id" params={{ id: tile.floor_plan.id }}>
        <LayoutGrid className="h-3.5 w-3.5" />
        {viaRack ? "On floor plan (via rack)" : "Show on floor plan"}
      </Link>
    </Button>
  )
}
