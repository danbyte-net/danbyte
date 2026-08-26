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
        onSaved={(i, count) =>
          // A [a-b] name range creates several - show them together on the
          // device rather than dropping onto the last one.
          count > 1
            ? nav({ to: "/devices/$id", params: { id: i.device.id } })
            : nav({ to: "/interfaces/$id", params: { id: i.id } })
        }
        onCancel={() => nav({ to: "/interfaces" })}
      />
    </EditPageShell>
  )
}
