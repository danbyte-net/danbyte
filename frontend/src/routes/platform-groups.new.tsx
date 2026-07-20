import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { PlatformGroupForm } from "@/components/platform-group-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/platform-groups/new")({
  component: NewPlatformGroupPage,
})

function NewPlatformGroupPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Platform groups", to: "/platform-groups" },
        { label: "Add" },
      ]}
      title="Add platform group"
      subtitle="A grouping of platforms (Windows, Linux, network NOS, …). Groups can nest."
    >
      <PlatformGroupForm
        onSaved={(g) =>
          nav({ to: "/platform-groups/$id", params: { id: g.id } })
        }
        onCancel={() => nav({ to: "/platform-groups" })}
      />
    </EditPageShell>
  )
}
