import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { AsnForm } from "@/components/asn-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/asns/new")({
  component: NewAsnPage,
})

function NewAsnPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "ASNs", to: "/asns" }, { label: "Add" }]}
      title="Add ASN"
      subtitle="An Autonomous System Number, optionally tied to a RIR and sites."
    >
      <AsnForm
        onSaved={(a) => nav({ to: "/asns/$id", params: { id: a.id } })}
        onCancel={() => nav({ to: "/asns" })}
      />
    </EditPageShell>
  )
}
