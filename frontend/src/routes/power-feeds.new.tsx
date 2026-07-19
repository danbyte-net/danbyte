import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { PowerFeedForm } from "@/components/power-feed-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/power-feeds/new")({
  component: NewPowerFeedPage,
})

function NewPowerFeedPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[{ label: "Power feeds", to: "/power-feeds" }, { label: "Add" }]}
      title="Add power feed"
      subtitle="A feed from a panel, optionally delivered to a rack."
    >
      <PowerFeedForm
        onSaved={() => nav({ to: "/power-feeds" })}
        onCancel={() => nav({ to: "/power-feeds" })}
      />
    </EditPageShell>
  )
}
