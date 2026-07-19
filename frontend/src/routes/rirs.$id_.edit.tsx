import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type RIR } from "@/lib/api"
import { RirForm } from "@/components/rir-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/rirs/$id_/edit")({
  component: EditRirPage,
})

function EditRirPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["rir", id],
    queryFn: () => api<RIR>(`/api/rirs/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "RIRs", to: "/rirs" },
        { label: q.data?.name ?? "…", to: "/rirs/$id", params: { id } },
        { label: "Edit" },
      ]}
      title="Edit RIR"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RirForm
          rir={q.data}
          onSaved={(r) => nav({ to: "/rirs/$id", params: { id: r.id } })}
          onCancel={() => nav({ to: "/rirs/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
