import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type IPAddress } from "@/lib/api"
import { IpForm } from "@/components/ip-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/ips/$id_/edit")({
  component: EditIpPage,
})

function EditIpPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["ip", id],
    queryFn: () => api<IPAddress>(`/api/ips/${id}/`),
  })
  const backToDetail = () => nav({ to: "/ips/$id", params: { id } })

  return (
    <EditPageShell
      presenceType="ipaddress"
      presenceId={id}
      crumbs={[
        { label: "Prefixes", to: "/prefixes" },
        q.data
          ? { label: q.data.ip_address, to: "/ips/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.ip_address}` : "Edit IP"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <IpForm ip={q.data} onSaved={backToDetail} onCancel={backToDetail} />
      )}
    </EditPageShell>
  )
}
