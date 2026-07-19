import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { FloorPlanForm } from "@/components/floor-plan-form"

export const Route = createFileRoute("/floorplans/new")({
  component: NewFloorPlanPage,
  validateSearch: (s: Record<string, unknown>): { location?: string } => ({
    ...(typeof s.location === "string" ? { location: s.location } : {}),
  }),
})

function NewFloorPlanPage() {
  const nav = useNavigate()
  const { location } = Route.useSearch()
  return (
    <EditPageShell
      crumbs={[{ label: "Floor plans", to: "/floorplans" }, { label: "Add" }]}
      title="Add floor plan"
      subtitle="A grid layout of a location — place tiles for racks, walls, cooling… and link them to real objects."
    >
      <FloorPlanForm
        initialLocationId={location}
        onSaved={(p) => nav({ to: "/floorplans/$id", params: { id: p.id } })}
        onCancel={() => nav({ to: "/floorplans" })}
      />
    </EditPageShell>
  )
}
