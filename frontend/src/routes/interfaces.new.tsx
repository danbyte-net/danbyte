import { toast } from "sonner"
import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { InterfaceForm } from "@/components/interface-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { planSearch } from "@/lib/save-object"

export const Route = createFileRoute("/interfaces/new")({
  component: NewInterfacePage,
  // `device` pre-selects the parent; `plan`/`planBoard` stage the new interface
  // on a task instead of creating it.
  validateSearch: (s: Record<string, unknown>) => ({
    ...(typeof s.device === "string" ? { device: s.device } : {}),
    ...planSearch(s),
  }),
})

function NewInterfacePage() {
  const nav = useNavigate()
  const { device } = Route.useSearch()
  return (
    <EditPageShell
      wide
      className="max-w-5xl"
      crumbs={[{ label: "Interfaces", to: "/interfaces" }, { label: "Add" }]}
      title="Add interface"
      subtitle="A network interface (port) on a device."
    >
      <InterfaceForm
        initialDeviceId={device}
        onSaved={(i, count) => {
          // A [a-b] name range creates several - show them together on the
          // device rather than dropping onto the last one.
          if (count > 1) {
            void nav({ to: "/devices/$id", params: { id: i.device.id } })
            return
          }
          void nav({ to: "/interfaces/$id", params: { id: i.id } })
          // Addressing a port right after making it is the common next move,
          // and the IP form owns the fields an IP actually needs.
          toast("Give it an address?", {
            action: {
              label: "Add an IP",
              onClick: () =>
                nav({ to: "/ips/new", search: { interface: i.id } }),
            },
          })
        }}
        onCancel={() => nav({ to: "/interfaces" })}
      />
    </EditPageShell>
  )
}
