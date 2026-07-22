import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type IPAddress } from "@/lib/api"
import { IpForm } from "@/components/ip-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { useReturnTo } from "@/lib/return-to"

export const Route = createFileRoute("/ips/$id_/edit")({
  component: EditIpPage,
  // ?from=<href> — e.g. a prefix's IPs tab sends the user back there on save,
  // instead of always landing on the IP detail page.
  validateSearch: (s: Record<string, unknown>): { from?: string } => ({
    ...(typeof s.from === "string" ? { from: s.from } : {}),
  }),
})

function EditIpPage() {
  const { id } = Route.useParams()
  const { from } = Route.useSearch()
  const nav = useNavigate()
  const goBack = useReturnTo(from)
  const q = useQuery({
    queryKey: ["ip", id],
    queryFn: () => api<IPAddress>(`/api/ips/${id}/`),
  })
  const backToDetail = () =>
    goBack(() => nav({ to: "/ips/$id", params: { id } }))

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
