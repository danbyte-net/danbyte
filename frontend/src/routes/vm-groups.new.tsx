import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { VmGroupForm } from "@/components/vm-group-form"

export const Route = createFileRoute("/vm-groups/new")({
  component: NewVmGroupPage,
  // ?cluster= pre-selects the cluster - the cluster page's Groups tab links
  // here with its own id.
  validateSearch: (s: Record<string, unknown>): { cluster?: string } => ({
    cluster: typeof s.cluster === "string" ? s.cluster : undefined,
  }),
})

function NewVmGroupPage() {
  const nav = useNavigate()
  const { cluster } = Route.useSearch()
  return (
    <EditPageShell
      crumbs={[{ label: "VM groups", to: "/vm-groups" }, { label: "Add" }]}
      title="Add VM group"
      subtitle="A named set of VMs on one cluster."
    >
      <VmGroupForm
        clusterId={cluster}
        onSaved={(g) => nav({ to: "/vm-groups/$id", params: { id: g.id } })}
        onCancel={() => nav({ to: "/vm-groups" })}
      />
    </EditPageShell>
  )
}
