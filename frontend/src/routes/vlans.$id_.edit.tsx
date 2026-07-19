import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type VLAN } from "@/lib/api"
import { VlanForm } from "@/components/vlan-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/vlans/$id_/edit")({
  component: EditVlanPage,
})

function EditVlanPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["vlan", id],
    queryFn: () => api<VLAN>(`/api/vlans/${id}/`),
  })
  const backToDetail = () => nav({ to: "/vlans/$id", params: { id } })

  return (
    <EditPageShell
      presenceType="vlan"
      presenceId={id}
      crumbs={[
        { label: "VLANs", to: "/vlans" },
        q.data
          ? {
              label: `${q.data.vlan_id} · ${q.data.name}`,
              to: "/vlans/$id",
              params: { id },
            }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit VLAN ${q.data.vlan_id}` : "Edit VLAN"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <VlanForm
          vlan={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
