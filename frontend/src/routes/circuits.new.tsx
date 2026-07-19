import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CircuitForm } from "@/components/circuit-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/circuits/new")({
  component: NewCircuitPage,
})

function NewCircuitPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Circuits", to: "/circuits" }, { label: "Add" }]}
      title="Add circuit"
      subtitle="A data circuit leased from a provider."
    >
      <CircuitForm
        onSaved={() => nav({ to: "/circuits" })}
        onCancel={() => nav({ to: "/circuits" })}
      />
    </EditPageShell>
  )
}
