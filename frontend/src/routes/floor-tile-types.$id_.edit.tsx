import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { FloorTileType } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import { FloorTileTypeForm } from "@/components/floor-tile-type-form"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/floor-tile-types/$id/edit")({
  component: EditFloorTileTypePage,
})

function EditFloorTileTypePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["floor-tile-type", id],
    queryFn: () => api<FloorTileType>(`/api/floor-tile-types/${id}/`),
  })
  const back = () => nav({ to: "/floor-tile-types" })

  return (
    <EditPageShell
      crumbs={[
        { label: "Floor tiles", to: "/floor-tile-types" },
        q.data ? { label: q.data.name } : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit floor tile type"}
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <FloorTileTypeForm tileType={q.data} onSaved={back} onCancel={back} />
      )}
    </EditPageShell>
  )
}
