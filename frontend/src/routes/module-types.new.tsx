import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { ModuleTypeForm } from "@/components/module-type-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/module-types/new")({
  component: NewModuleTypePage,
})

function NewModuleTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Module types", to: "/module-types" },
        { label: "Add" },
      ]}
      title="Add module type"
      subtitle="A pluggable hardware model — line card, uplink module, PSU sled."
    >
      <ModuleTypeForm
        onSaved={(m) => nav({ to: "/module-types/$id", params: { id: m.id } })}
        onCancel={() => nav({ to: "/module-types" })}
      />
    </EditPageShell>
  )
}
