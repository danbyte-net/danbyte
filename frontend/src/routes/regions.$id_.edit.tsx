import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type Region } from "@/lib/api"
import { RegionForm } from "@/components/region-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/regions/$id_/edit")({
  component: EditRegionPage,
})

function EditRegionPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["region", id],
    queryFn: () => api<Region>(`/api/regions/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Regions", to: "/regions" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit region"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RegionForm
          region={q.data}
          onSaved={() => nav({ to: "/regions" })}
          onCancel={() => nav({ to: "/regions" })}
        />
      )}
    </EditPageShell>
  )
}
