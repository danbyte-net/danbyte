import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ModuleType } from "@/lib/api"
import { ModuleTypeForm } from "@/components/module-type-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/module-types/$id_/edit")({
  component: EditModuleTypePage,
})

function EditModuleTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["module-type", id],
    queryFn: () => api<ModuleType>(`/api/module-types/${id}/`),
  })
  const back = () => nav({ to: "/module-types/$id", params: { id } })
  return (
    <EditPageShell
      crumbs={[
        { label: "Module types", to: "/module-types" },
        { label: q.data?.name ?? "…" },
      ]}
      title={`Edit ${q.data?.name ?? "module type"}`}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <ModuleTypeForm moduleType={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
