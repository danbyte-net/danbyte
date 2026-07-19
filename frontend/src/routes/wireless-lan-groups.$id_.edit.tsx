import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type WirelessLANGroup } from "@/lib/api"
import { WlanGroupForm } from "@/components/wlan-group-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/wireless-lan-groups/$id_/edit")({
  component: EditWlanGroupPage,
})

function EditWlanGroupPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["wireless-lan-group", id],
    queryFn: () => api<WirelessLANGroup>(`/api/wireless-lan-groups/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Wireless LAN groups", to: "/wireless-lan-groups" },
        { label: q.data?.name ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit wireless LAN group"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <WlanGroupForm
          item={q.data}
          onSaved={() => nav({ to: "/wireless-lan-groups" })}
          onCancel={() => nav({ to: "/wireless-lan-groups" })}
        />
      )}
    </EditPageShell>
  )
}
