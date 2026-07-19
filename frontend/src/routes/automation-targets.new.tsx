import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { AutomationTargetForm } from "@/components/automation-target-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/automation-targets/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Automation targets", to: "/automation-targets" },
        { label: "Add" },
      ]}
      title="Add automation target"
      subtitle="An AWX/AAP job template or webhook Danbyte dispatches a deploy to."
    >
      <p className="mb-4 max-w-2xl text-[13px] text-muted-foreground">
        Not sure what goes where?{" "}
        <Link
          to="/automation-targets/setup"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Use guided setup
        </Link>{" "}
        instead — it walks you through the same fields.
      </p>
      <AutomationTargetForm
        onSaved={() => nav({ to: "/automation-targets" })}
        onCancel={() => nav({ to: "/automation-targets" })}
      />
    </EditPageShell>
  )
}
