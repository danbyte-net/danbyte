import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { AreaTypeForm } from "@/components/area-type-form"

export const Route = createFileRoute("/area-types/new")({
  component: NewAreaTypePage,
})

function NewAreaTypePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Area types", to: "/area-types" }, { label: "Add" }]}
      title="Add area type"
    >
      <AreaTypeForm
        onSaved={(t) => nav({ to: "/area-types/$id", params: { id: t.id } })}
        onCancel={() => nav({ to: "/area-types" })}
      />
    </EditPageShell>
  )
}
