import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { BFDProfileForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/bfd-profiles/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "BFD profiles", to: "/bfd-profiles" },
        { label: "Add" },
      ]}
      title="Add BFD profile"
      subtitle="Timers named once, applied wherever BFD is on."
    >
      <BFDProfileForm
        onSaved={(v) => nav({ to: "/bfd-profiles/$id", params: { id: v.id } })}
        onCancel={() => nav({ to: "/bfd-profiles" })}
      />
    </EditPageShell>
  )
}
