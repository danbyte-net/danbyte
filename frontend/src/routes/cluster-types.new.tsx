import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ClusterTypeForm } from "@/components/cluster-type-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/cluster-types/new")({
  component: NewClusterTypePage,
})

function NewClusterTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Cluster types", to: "/cluster-types" },
        { label: "Add" },
      ]}
      title="Add cluster type"
      subtitle="A kind of cluster (VMware vSphere, Proxmox, Hyper-V, …)."
    >
      <ClusterTypeForm
        onSaved={(m) => nav({ to: "/cluster-types/$id", params: { id: m.id } })}
        onCancel={() => nav({ to: "/cluster-types" })}
      />
    </EditPageShell>
  )
}
