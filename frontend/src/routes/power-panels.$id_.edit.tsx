import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type PowerPanel } from "@/lib/api"
import { PowerPanelForm } from "@/components/power-panel-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/power-panels/$id_/edit")({
  component: EditPowerPanelPage,
})

function EditPowerPanelPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["power-panel", id],
    queryFn: () => api<PowerPanel>(`/api/power-panels/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Power panels", to: "/power-panels" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit power panel"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <PowerPanelForm
          panel={q.data}
          onSaved={() => nav({ to: "/power-panels" })}
          onCancel={() => nav({ to: "/power-panels" })}
        />
      )}
    </EditPageShell>
  )
}
