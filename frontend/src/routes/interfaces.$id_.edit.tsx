import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Interface } from "@/lib/api"
import { InterfaceForm } from "@/components/interface-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/interfaces/$id_/edit")({
  component: EditInterfacePage,
})

function EditInterfacePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["interface", id],
    queryFn: () => api<Interface>(`/api/interfaces/${id}/`),
  })
  const back = () => nav({ to: "/interfaces/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Interfaces", to: "/interfaces" },
        q.data
          ? { label: q.data.name, to: "/interfaces/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit interface"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <InterfaceForm iface={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
