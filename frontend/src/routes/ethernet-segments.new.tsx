import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { EthernetSegmentForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/ethernet-segments/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Ethernet segments", to: "/ethernet-segments" },
        { label: "Add" },
      ]}
      title="Add Ethernet segment"
      subtitle="The LAGs on two leaves that one multihomed server plugs into."
    >
      <EthernetSegmentForm
        onSaved={(v) =>
          nav({ to: "/ethernet-segments/$id", params: { id: v.id } })
        }
        onCancel={() => nav({ to: "/ethernet-segments" })}
      />
    </EditPageShell>
  )
}
