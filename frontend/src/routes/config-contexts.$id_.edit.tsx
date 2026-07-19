import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type ConfigContext } from "@/lib/api"
import { ConfigContextForm } from "@/components/config-context-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/config-contexts/$id_/edit")({
  component: EditConfigContextPage,
})

function EditConfigContextPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["config-context", id],
    queryFn: () => api<ConfigContext>(`/api/config-contexts/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Config contexts", to: "/config-contexts" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit config context"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ConfigContextForm
          context={q.data}
          onSaved={() => nav({ to: "/config-contexts" })}
          onCancel={() => nav({ to: "/config-contexts" })}
        />
      )}
    </EditPageShell>
  )
}
