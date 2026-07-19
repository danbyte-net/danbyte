import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { WirelessLANForm } from "@/components/wireless-lan-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/wireless-lans/new")({
  component: NewWirelessLANPage,
})

function NewWirelessLANPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Wireless LANs", to: "/wireless-lans" },
        { label: "Add" },
      ]}
      title="Add wireless LAN"
      subtitle="An SSID, optionally bridged to a VLAN."
    >
      <WirelessLANForm
        onSaved={() => nav({ to: "/wireless-lans" })}
        onCancel={() => nav({ to: "/wireless-lans" })}
      />
    </EditPageShell>
  )
}
