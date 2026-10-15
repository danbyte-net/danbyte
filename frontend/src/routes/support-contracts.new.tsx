import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { SupportContractForm } from "@/components/support-contract-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/support-contracts/new")({
  component: NewSupportContractPage,
})

function NewSupportContractPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Support contracts", to: "/support-contracts" },
        { label: "Add" },
      ]}
      title="Add contract"
      subtitle="A support or warranty contract with a manufacturer."
    >
      <SupportContractForm
        onSaved={(c) =>
          nav({ to: "/support-contracts/$id", params: { id: c.id } })
        }
        onCancel={() => nav({ to: "/support-contracts" })}
      />
    </EditPageShell>
  )
}
