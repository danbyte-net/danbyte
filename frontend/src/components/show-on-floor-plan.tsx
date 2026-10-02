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

/** The tiles that link to one object (`/api/floor-plan-tiles/?<kind>=<id>`). */
function usePlacements(kind: "device" | "rack" | "cabinet", id?: string) {
  return useQuery({
    queryKey: ["floor-tile-placement", kind, id],
    queryFn: () =>
      api<Paginated<FloorPlanTile>>(`/api/floor-plan-tiles/?${kind}=${id}`),
    enabled: !!id,
  })
}

/**
 * "Show on floor plan" - opens the plan where this rack, cabinet or device is
 * placed, zoomed onto its tile. For a device, falls back to its rack's or
 * cabinet's placement ("via rack", "via cabinet") when the device itself
 * isn't tiled. Placed on several plans (a device tile and its rack, or a
 * second what-if plan) - a menu lists them. Renders nothing when nothing is
 * placed.
 */
export function ShowOnFloorPlan({
  deviceId,
  rackId,
  cabinetId,
}: {
  deviceId?: string
  rackId?: string
  cabinetId?: string
}) {
  const deviceQ = usePlacements("device", deviceId)
  const rackQ = usePlacements("rack", rackId)
  const cabinetQ = usePlacements("cabinet", cabinetId)
  // A rack's or a cabinet's tile is where a DEVICE sits only by way of it;
  // on the rack's or the cabinet's own page it is simply where it stands.
  const via = (what: "rack" | "cabinet") => (deviceId ? what : null)
  const placements = [
    ...(deviceQ.data?.results ?? []).map((t) => ({ tile: t, via: null })),
    ...(rackQ.data?.results ?? []).map((t) => ({ tile: t, via: via("rack") })),
    ...(cabinetQ.data?.results ?? []).map((t) => ({
      tile: t,
      via: via("cabinet"),
    })),
  ].filter((p) => p.tile.floor_plan)
  if (placements.length === 0) return null
  const first = placements[0]
  const label = (p: (typeof placements)[number]) =>
    `${p.tile.floor_plan!.name}${p.via ? ` (via ${p.via})` : ""}`
  if (placements.length === 1)
    return (
      <Button variant="outline" size="sm" asChild>
        <Link
          to="/floorplans/$id"
          params={{ id: first.tile.floor_plan!.id }}
          search={{ tile: first.tile.id }}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          {first.via
            ? `On floor plan (via ${first.via})`
            : "Show on floor plan"}
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
