import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Prefix } from "@/lib/api"
import { PrefixForm } from "@/components/prefix-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/prefixes/$id_/edit")({
  component: EditPrefixPage,
})

function EditPrefixPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["prefix", id],
    queryFn: () => api<Prefix>(`/api/prefixes/${id}/`),
  })
  const backToDetail = () => nav({ to: "/prefixes/$id", params: { id } })

  return (
    <EditPageShell
      presenceType="prefix"
      presenceId={id}
      crumbs={[
        { label: "Prefixes", to: "/prefixes" },
        q.data
          ? { label: q.data.cidr, to: "/prefixes/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.cidr}` : "Edit prefix"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PrefixForm
          prefix={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
