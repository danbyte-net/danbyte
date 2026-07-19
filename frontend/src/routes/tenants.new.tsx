import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { TenantForm } from "@/components/tenant-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/tenants/new")({
  component: NewTenantPage,
})

function NewTenantPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Tenants", to: "/tenants" }, { label: "Add" }]}
      title="Add tenant"
      subtitle="Hard isolation scope. Every record in the app belongs to one tenant."
    >
      <TenantForm
        onSaved={(t) => nav({ to: "/tenants/$id", params: { id: t.id } })}
        onCancel={() => nav({ to: "/tenants" })}
      />
    </EditPageShell>
  )
}
