import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CoolingSourceForm } from "@/components/cooling-source-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/cooling-sources/new")({
  component: NewCoolingSourcePage,
})

function NewCoolingSourcePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Cooling sources", to: "/cooling-sources" },
        { label: "Add" },
      ]}
      title="Add cooling source"
      subtitle="A cooling unit within a site."
    >
      <CoolingSourceForm
        onSaved={() => nav({ to: "/cooling-sources" })}
        onCancel={() => nav({ to: "/cooling-sources" })}
      />
    </EditPageShell>
  )
}
