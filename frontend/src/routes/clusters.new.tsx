import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ClusterForm } from "@/components/cluster-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/clusters/new")({
  component: NewClusterPage,
})

function NewClusterPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Clusters", to: "/clusters" }, { label: "Add" }]}
      title="Add cluster"
      subtitle="A group of hosts running virtual machines."
    >
      <ClusterForm
        onSaved={(c) => nav({ to: "/clusters/$id", params: { id: c.id } })}
        onCancel={() => nav({ to: "/clusters" })}
      />
    </EditPageShell>
  )
}
