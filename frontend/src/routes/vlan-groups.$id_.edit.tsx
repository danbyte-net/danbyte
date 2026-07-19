import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type VLANGroup } from "@/lib/api"
import { VlanGroupForm } from "@/components/vlan-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/vlan-groups/$id_/edit")({
  component: EditVlanGroupPage,
})

function EditVlanGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["vlan-group", id],
    queryFn: () => api<VLANGroup>(`/api/vlan-groups/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "VLAN groups", to: "/vlan-groups" },
        {
          label: q.data?.name ?? "…",
          to: "/vlan-groups/$id",
          params: { id },
        },
        { label: "Edit" },
      ]}
      title="Edit VLAN group"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <VlanGroupForm
          group={q.data}
          onSaved={(g) => nav({ to: "/vlan-groups/$id", params: { id: g.id } })}
          onCancel={() => nav({ to: "/vlan-groups/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
