import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { RegionForm } from "@/components/region-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/regions/new")({
  component: NewRegionPage,
})

function NewRegionPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Regions", to: "/regions" }, { label: "Add" }]}
      title="Add region"
      subtitle="A geographic/organisational grouping above sites."
    >
      <RegionForm
        onSaved={() => nav({ to: "/regions" })}
        onCancel={() => nav({ to: "/regions" })}
      />
    </EditPageShell>
  )
}
