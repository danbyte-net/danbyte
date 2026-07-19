import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { VirtualChassisForm } from "@/components/virtual-chassis-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/virtual-chassis/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Virtual chassis", to: "/virtual-chassis" },
        { label: "Add" },
      ]}
      title="Add Virtual chassis"
      subtitle="A set of physical switches stacked into one logical device. Devices join from their own edit form."
    >
      <VirtualChassisForm
        onSaved={(v) =>
          nav({ to: "/virtual-chassis/$id", params: { id: v.id } })
        }
        onCancel={() => nav({ to: "/virtual-chassis" })}
      />
    </EditPageShell>
  )
}
