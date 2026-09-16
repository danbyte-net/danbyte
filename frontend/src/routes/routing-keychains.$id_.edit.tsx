import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { RoutingKeychain } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"
import { RoutingKeychainForm } from "@/components/routing/object-forms"
import { keychainDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/routing-keychains/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: [keychainDetail.queryKey, id],
    queryFn: () => api<RoutingKeychain>(`${keychainDetail.endpoint}${id}/`),
  })
  const back = () => nav({ to: "/routing-keychains/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Routing keychains", to: "/routing-keychains" },
        { label: q.data ? keychainDetail.title(q.data) : "…" },
        { label: "Edit" },
      ]}
      title="Edit keychain"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RoutingKeychainForm item={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
