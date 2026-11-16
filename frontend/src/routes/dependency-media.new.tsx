import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { DependencyMediumForm } from "@/components/dependency-medium-form"

export const Route = createFileRoute("/dependency-media/new")({
  component: NewDependencyMediumPage,
})

function NewDependencyMediumPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Dependency media", to: "/dependency-media" },
        { label: "Add" },
      ]}
      title="Add dependency medium"
    >
      <DependencyMediumForm
        onSaved={(m) =>
          nav({ to: "/dependency-media/$id", params: { id: m.id } })
        }
        onCancel={() => nav({ to: "/dependency-media" })}
      />
    </EditPageShell>
  )
}
