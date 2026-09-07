import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, LayoutGrid } from "lucide-react"

import { api } from "@/lib/api"
import type { FloorPlanTile, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * "Show on floor plan" - opens the plan where this rack/device is placed,
 * zoomed onto its tile. For a device, falls back to its rack's placement
 * ("via rack") when the device itself isn't tiled. Placed on several plans
 * (a device tile and its rack, or a second what-if plan) - a menu lists them.
 * Renders nothing when nothing is placed.
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
  const placements = [
    ...(deviceQ.data?.results ?? []).map((t) => ({ tile: t, viaRack: false })),
    ...(rackQ.data?.results ?? []).map((t) => ({ tile: t, viaRack: true })),
  ].filter((p) => p.tile.floor_plan)
  if (placements.length === 0) return null
  const first = placements[0]
  const label = (p: (typeof placements)[number]) =>
    `${p.tile.floor_plan!.name}${p.viaRack ? " (via rack)" : ""}`
  if (placements.length === 1)
    return (
      <Button variant="outline" size="sm" asChild>
        <Link
          to="/floorplans/$id"
          params={{ id: first.tile.floor_plan!.id }}
          search={{ tile: first.tile.id }}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          {first.viaRack ? "On floor plan (via rack)" : "Show on floor plan"}
        </Link>
      </Button>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <LayoutGrid className="h-3.5 w-3.5" />
          Show on floor plan
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {placements.map((p) => (
          <DropdownMenuItem key={p.tile.id} asChild>
            <Link
              to="/floorplans/$id"
              params={{ id: p.tile.floor_plan!.id }}
              search={{ tile: p.tile.id }}
            >
              {label(p)}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
