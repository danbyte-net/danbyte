import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CircuitTypeForm } from "@/components/circuit-type-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/circuit-types/new")({
  component: NewCircuitTypePage,
})

function NewCircuitTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Circuit types", to: "/circuit-types" },
        { label: "Add" },
      ]}
      title="Add circuit type"
      subtitle="A classification for circuits (Internet, Transit, MPLS…)."
    >
      <CircuitTypeForm
        onSaved={() => nav({ to: "/circuit-types" })}
        onCancel={() => nav({ to: "/circuit-types" })}
      />
    </EditPageShell>
  )
}
