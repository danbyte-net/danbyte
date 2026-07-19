import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type Location } from "@/lib/api"
import { LocationForm } from "@/components/location-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/locations/$id_/edit")({
  component: EditLocationPage,
})

function EditLocationPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["location", id],
    queryFn: () => api<Location>(`/api/locations/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Locations", to: "/locations" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit location"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <LocationForm
          location={q.data}
          onSaved={() => nav({ to: "/locations" })}
          onCancel={() => nav({ to: "/locations" })}
        />
      )}
    </EditPageShell>
  )
}
