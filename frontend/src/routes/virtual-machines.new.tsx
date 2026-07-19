import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { VmForm } from "@/components/vm-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/virtual-machines/new")({
  component: NewVmPage,
})

function NewVmPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Virtual machines", to: "/virtual-machines" },
        { label: "Add" },
      ]}
      title="Add virtual machine"
      subtitle="A virtual machine running on a cluster."
    >
      <VmForm
        onSaved={(vm) =>
          nav({ to: "/virtual-machines/$id", params: { id: vm.id } })
        }
        onCancel={() => nav({ to: "/virtual-machines" })}
      />
    </EditPageShell>
  )
}
