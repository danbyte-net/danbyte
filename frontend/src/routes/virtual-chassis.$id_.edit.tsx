import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type VirtualChassis } from "@/lib/api"
import { VirtualChassisForm } from "@/components/virtual-chassis-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/virtual-chassis/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["virtual-chassis", id],
    queryFn: () => api<VirtualChassis>(`/api/virtual-chassis/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Virtual chassis", to: "/virtual-chassis" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit Virtual chassis"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <VirtualChassisForm
          item={q.data}
          onSaved={() => nav({ to: "/virtual-chassis/$id", params: { id } })}
          onCancel={() => nav({ to: "/virtual-chassis/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
