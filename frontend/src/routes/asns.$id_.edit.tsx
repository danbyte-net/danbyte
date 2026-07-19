import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ASN } from "@/lib/api"
import { AsnForm } from "@/components/asn-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/asns/$id_/edit")({
  component: EditAsnPage,
})

function EditAsnPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["asn", id],
    queryFn: () => api<ASN>(`/api/asns/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "ASNs", to: "/asns" },
        {
          label: q.data ? `AS${q.data.asn}` : "…",
          to: "/asns/$id",
          params: { id },
        },
        { label: "Edit" },
      ]}
      title="Edit ASN"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <AsnForm
          asn={q.data}
          onSaved={(a) => nav({ to: "/asns/$id", params: { id: a.id } })}
          onCancel={() => nav({ to: "/asns/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
