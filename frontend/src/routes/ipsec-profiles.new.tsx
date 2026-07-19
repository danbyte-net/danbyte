import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { IPSecProfileForm } from "@/components/ipsec-profile-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/ipsec-profiles/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "IPSec profiles", to: "/ipsec-profiles" },
        { label: "Add" },
      ]}
      title="Add IPSec profile"
      subtitle="A reusable IKE/IPSec crypto profile."
    >
      <IPSecProfileForm
        onSaved={() => nav({ to: "/ipsec-profiles" })}
        onCancel={() => nav({ to: "/ipsec-profiles" })}
      />
    </EditPageShell>
  )
}
