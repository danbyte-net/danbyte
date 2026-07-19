import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type IPRange } from "@/lib/api"
import { IpRangeForm } from "@/components/ip-range-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/ip-ranges/$id_/edit")({
  component: EditIpRangePage,
})

function EditIpRangePage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["ip-range", id],
    queryFn: () => api<IPRange>(`/api/ip-ranges/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "IP ranges", to: "/ip-ranges" },
        {
          label: q.data ? `${q.data.start_address}–${q.data.end_address}` : "…",
          to: "/ip-ranges/$id",
          params: { id },
        },
        { label: "Edit" },
      ]}
      title="Edit IP range"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <IpRangeForm
          range={q.data}
          onSaved={(r) => nav({ to: "/ip-ranges/$id", params: { id: r.id } })}
          onCancel={() => nav({ to: "/ip-ranges/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
