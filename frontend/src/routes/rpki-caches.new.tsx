import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { RPKICacheForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/rpki-caches/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "RPKI caches", to: "/rpki-caches" }, { label: "Add" }]}
      title="Add RPKI cache"
      subtitle="An RTR server BGP instances validate route origins against."
    >
      <RPKICacheForm
        onSaved={(v) => nav({ to: "/rpki-caches/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/rpki-caches" })}
      />
    </EditPageShell>
  )
}
