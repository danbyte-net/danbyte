import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { SensitivityLabelForm } from "@/components/sensitivity-label-form"

export const Route = createFileRoute("/sensitivity-labels/new")({
  component: NewSensitivityLabelPage,
})

function NewSensitivityLabelPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Sensitivity labels", to: "/sensitivity-labels" },
        { label: "Add" },
      ]}
      title="Add sensitivity label"
    >
      <SensitivityLabelForm
        onSaved={(l) =>
          nav({ to: "/sensitivity-labels/$id", params: { id: l.id } })
        }
        onCancel={() => nav({ to: "/sensitivity-labels" })}
      />
    </EditPageShell>
  )
}
