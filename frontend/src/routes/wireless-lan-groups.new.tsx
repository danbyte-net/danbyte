import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { WlanGroupForm } from "@/components/wlan-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/wireless-lan-groups/new")({
  component: NewWlanGroupPage,
})

function NewWlanGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Wireless LAN groups", to: "/wireless-lan-groups" },
        { label: "Add" },
      ]}
      title="Add wireless LAN group"
      subtitle="An organisational grouping of SSIDs."
    >
      <WlanGroupForm
        onSaved={() => nav({ to: "/wireless-lan-groups" })}
        onCancel={() => nav({ to: "/wireless-lan-groups" })}
      />
    </EditPageShell>
  )
}
