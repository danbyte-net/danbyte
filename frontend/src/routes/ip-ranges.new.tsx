import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { IpRangeForm } from "@/components/ip-range-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/ip-ranges/new")({
  component: NewIpRangePage,
})

function NewIpRangePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "IP ranges", to: "/ip-ranges" }, { label: "Add" }]}
      title="Add IP range"
      subtitle="A contiguous span of addresses — e.g. a DHCP pool."
    >
      <IpRangeForm
        onSaved={(r) => nav({ to: "/ip-ranges/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/ip-ranges" })}
      />
    </EditPageShell>
  )
}
