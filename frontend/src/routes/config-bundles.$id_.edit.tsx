import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { ConfigBundle } from "@/lib/api"
import { ConfigBundleForm } from "@/components/config-bundle-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/config-bundles/$id_/edit")({
  component: EditConfigBundlePage,
})

function EditConfigBundlePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["config-bundle", id],
    queryFn: () => api<ConfigBundle>(`/api/config-bundles/${id}/`),
  })
  const back = () => nav({ to: "/config-bundles/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Config bundles", to: "/config-bundles" },
        q.data
          ? { label: q.data.name, to: "/config-bundles/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title="Edit config bundle"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ConfigBundleForm bundle={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
