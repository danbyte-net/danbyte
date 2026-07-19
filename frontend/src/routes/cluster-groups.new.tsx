import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ClusterGroupForm } from "@/components/cluster-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/cluster-groups/new")({
  component: NewClusterGroupPage,
})

function NewClusterGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Cluster groups", to: "/cluster-groups" },
        { label: "Add" },
      ]}
      title="Add cluster group"
      subtitle="A logical grouping of clusters (Production, Staging, …)."
    >
      <ClusterGroupForm
        onSaved={(m) =>
          nav({ to: "/cluster-groups/$id", params: { id: m.id } })
        }
        onCancel={() => nav({ to: "/cluster-groups" })}
      />
    </EditPageShell>
  )
}
