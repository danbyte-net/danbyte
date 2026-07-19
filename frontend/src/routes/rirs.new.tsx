import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { RirForm } from "@/components/rir-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/rirs/new")({
  component: NewRirPage,
})

function NewRirPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "RIRs", to: "/rirs" }, { label: "Add" }]}
      title="Add RIR"
      subtitle="A registry (or private space) that allocates aggregates."
    >
      <RirForm
        onSaved={(r) => nav({ to: "/rirs/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/rirs" })}
      />
    </EditPageShell>
  )
}
