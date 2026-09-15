import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { OSPFAreaForm } from "@/components/routing/igp-forms"

export const Route = createFileRoute("/ospf-areas/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "OSPF areas", to: "/ospf-areas" }, { label: "Add" }]}
      title="Add OSPF area"
      subtitle="An area every OSPF interface enrols in - the backbone and the ones behind it."
    >
      <OSPFAreaForm
        onSaved={(v) => nav({ to: "/ospf-areas/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/ospf-areas" })}
      />
    </EditPageShell>
  )
}
