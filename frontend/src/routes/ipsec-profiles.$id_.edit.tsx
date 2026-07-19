import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type IPSecProfile } from "@/lib/api"
import { IPSecProfileForm } from "@/components/ipsec-profile-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/ipsec-profiles/$id_/edit")({
  component: EditPage,
})

function EditPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["ipsec-profile", id],
    queryFn: () => api<IPSecProfile>(`/api/ipsec-profiles/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "IPSec profiles", to: "/ipsec-profiles" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit IPSec profile"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <IPSecProfileForm
          item={q.data}
          onSaved={() => nav({ to: "/ipsec-profiles" })}
          onCancel={() => nav({ to: "/ipsec-profiles" })}
        />
      )}
    </EditPageShell>
  )
}
