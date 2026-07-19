import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { api, type WirelessLAN } from "@/lib/api"
import { WirelessLANForm } from "@/components/wireless-lan-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/wireless-lans/$id_/edit")({
  component: EditWirelessLANPage,
})

function EditWirelessLANPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["wireless-lan", id],
    queryFn: () => api<WirelessLAN>(`/api/wireless-lans/${id}/`),
  })
  return (
    <EditPageShell
      crumbs={[
        { label: "Wireless LANs", to: "/wireless-lans" },
        { label: q.data?.ssid ?? "…" },
        { label: "Edit" },
      ]}
      title="Edit wireless LAN"
    >
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <WirelessLANForm
          wlan={q.data}
          onSaved={() => nav({ to: "/wireless-lans" })}
          onCancel={() => nav({ to: "/wireless-lans" })}
        />
      )}
    </EditPageShell>
  )
}
