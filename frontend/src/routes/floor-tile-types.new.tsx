import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { FloorTileTypeForm } from "@/components/floor-tile-type-form"
import { planSearch, type PlanSearch } from "@/lib/save-object"

export const Route = createFileRoute("/floor-tile-types/new")({
  component: NewFloorTileTypePage,
  // ?from=<floor plan id> — arriving from a plan's palette "+" sends the
  // user straight back to that plan after save/cancel.
  validateSearch: (
    s: Record<string, unknown>
  ): { from?: string } & PlanSearch => ({
    ...(typeof s.from === "string" ? { from: s.from } : {}),
    ...planSearch(s),
  }),
})

function NewFloorTileTypePage() {
  const nav = useNavigate()
  const { from } = Route.useSearch()
  const back = () => {
    if (from) nav({ to: "/floorplans/$id", params: { id: from } })
    else nav({ to: "/floor-tile-types" })
  }
  return (
    <EditPageShell
      crumbs={[
        { label: "Floor tiles", to: "/floor-tile-types" },
        { label: "Add" },
      ]}
      title="Add floor tile type"
      subtitle="A tile kind for the floor-plan palette — its name, color, and icon. Device roles double as tile types automatically."
    >
      <FloorTileTypeForm onSaved={back} onCancel={back} />
    </EditPageShell>
  )
}
