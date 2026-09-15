import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { RoutingPolicyForm } from "@/components/routing/list-forms"

export const Route = createFileRoute("/routing-policies/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Routing policies", to: "/routing-policies" },
        { label: "Add" },
      ]}
      title="Add routing policy"
      subtitle="A route map: ordered rules that match and set."
    >
      <RoutingPolicyForm
        onSaved={(v) =>
          nav({ to: "/routing-policies/$id", params: { id: v.id } })
        }
        onCancel={() => nav({ to: "/routing-policies" })}
      />
    </EditPageShell>
  )
}
