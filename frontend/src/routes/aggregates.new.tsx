import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { AggregateForm } from "@/components/aggregate-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/aggregates/new")({
  component: NewAggregatePage,
})

function NewAggregatePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Aggregates", to: "/aggregates" }, { label: "Add" }]}
      title="Add aggregate"
      subtitle="A top-level block of IP space allocated from a RIR."
    >
      <AggregateForm
        onSaved={(a) => nav({ to: "/aggregates/$id", params: { id: a.id } })}
        onCancel={() => nav({ to: "/aggregates" })}
      />
    </EditPageShell>
  )
}
