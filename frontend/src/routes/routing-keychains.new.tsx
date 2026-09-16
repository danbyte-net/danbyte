import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { RoutingKeychainForm } from "@/components/routing/object-forms"

export const Route = createFileRoute("/routing-keychains/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Routing keychains", to: "/routing-keychains" },
        { label: "Add" },
      ]}
      title="Add keychain"
      subtitle="The key BGP sessions and IGP interfaces authenticate with; stored in the secret store."
    >
      <RoutingKeychainForm
        onSaved={(v) =>
          nav({ to: "/routing-keychains/$id", params: { id: v.id } })
        }
        onCancel={() => nav({ to: "/routing-keychains" })}
      />
    </EditPageShell>
  )
}
