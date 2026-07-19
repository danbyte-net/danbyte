import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type FHRPGroup } from "@/lib/api"
import { FhrpGroupForm } from "@/components/fhrp-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/fhrp-groups/$id_/edit")({
  component: EditFhrpGroupPage,
})

function EditFhrpGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["fhrp-group", id],
    queryFn: () => api<FHRPGroup>(`/api/fhrp-groups/${id}/`),
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "FHRP groups", to: "/fhrp-groups" },
        {
          label: q.data ? `${q.data.protocol_display} ${q.data.group_id}` : "…",
          to: "/fhrp-groups/$id",
          params: { id },
        },
        { label: "Edit" },
      ]}
      title="Edit FHRP group"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <FhrpGroupForm
          group={q.data}
          onSaved={(g) => nav({ to: "/fhrp-groups/$id", params: { id: g.id } })}
          onCancel={() => nav({ to: "/fhrp-groups/$id", params: { id } })}
        />
      )}
    </EditPageShell>
  )
}
