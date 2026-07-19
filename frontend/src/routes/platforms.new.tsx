import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { PlatformForm } from "@/components/platform-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/platforms/new")({
  component: NewPlatformPage,
})

function NewPlatformPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Platforms", to: "/platforms" }, { label: "Add" }]}
      title="Add platform"
      subtitle="An OS / firmware a device or VM runs (IOS-XE, Junos, Ubuntu, …)."
    >
      <PlatformForm
        onSaved={(p) => nav({ to: "/platforms/$id", params: { id: p.id } })}
        onCancel={() => nav({ to: "/platforms" })}
      />
    </EditPageShell>
  )
}
