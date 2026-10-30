import { createFileRoute } from "@tanstack/react-router"

import { FloorPlanEditor } from "@/components/floorplan/floor-plan-editor"
import type { FloorPlanSearch } from "@/components/floorplan/floor-plan-editor"

export const Route = createFileRoute("/floorplans/$id")({
  component: FloorPlanPage,
  // ?trace=<cableId> - arrive with a cable's route highlighted + fitted,
  // without entering Cables mode. ?viz=3d - open straight into the 3D room.
  // (Named `viz`, not `view` - the monitoring route owns `view` in the
  // router-wide search union and a second meaning breaks its reducer types.)
  validateSearch: (s: Record<string, unknown>): FloorPlanSearch => ({
    ...(typeof s.trace === "string" ? { trace: s.trace } : {}),
    ...(s.viz === "3d" ? { viz: "3d" as const } : {}),
    // ?tile=<id> - arrive zoomed onto one tile ("Show on floor plan").
    ...(typeof s.tile === "string" ? { tile: s.tile } : {}),
    // ?area=<id> - arrive with a room / area opened ("Open in floor plan").
    ...(typeof s.area === "string" ? { area: s.area } : {}),
  }),
})

/** One floor plan - the editor lives in components/floorplan/. Switching
 * floors keeps it mounted; it resets its own state per plan. */
function FloorPlanPage() {
  const { id } = Route.useParams()
  const search = Route.useSearch()
  return <FloorPlanEditor id={id} search={search} />
}
