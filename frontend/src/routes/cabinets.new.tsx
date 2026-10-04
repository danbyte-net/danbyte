import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { CabinetForm } from "@/components/cabinet-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { planSearch } from "@/lib/save-object"
import type { PlanSearch } from "@/lib/save-object"

export const Route = createFileRoute("/cabinets/new")({
  // ?cabinet_type=<id> pre-picks the type - how the cabinet-type page's
  // "Add cabinet" lands here with its sizes already filled.
  validateSearch: (
    s: Record<string, unknown>
  ): { cabinet_type?: string } & PlanSearch => ({
    cabinet_type:
      typeof s.cabinet_type === "string" ? s.cabinet_type : undefined,
    ...planSearch(s),
  }),
  component: NewCabinetPage,
})

function NewCabinetPage() {
  const nav = useNavigate()
  const { cabinet_type } = Route.useSearch()
  return (
    <EditPageShell
      wide
      crumbs={[{ label: "Cabinets", to: "/cabinets" }, { label: "Add" }]}
      title="Add cabinet"
      subtitle="An enclosure whose gear mounts on DIN rails, placed in millimetres."
    >
      <CabinetForm
        initialCabinetTypeId={cabinet_type}
        onSaved={(c) => nav({ to: "/cabinets/$id", params: { id: c.id } })}
        onCancel={() => nav({ to: "/cabinets" })}
      />
    </EditPageShell>
  )
}
