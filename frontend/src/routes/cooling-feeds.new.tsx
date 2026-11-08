import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CoolingFeedForm } from "@/components/cooling-feed-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/cooling-feeds/new")({
  component: NewCoolingFeedPage,
})

function NewCoolingFeedPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Cooling feeds", to: "/cooling-feeds" },
        { label: "Add" },
      ]}
      title="Add cooling feed"
      subtitle="A loop from a cooling source, optionally to a rack."
    >
      <CoolingFeedForm
        onSaved={() => nav({ to: "/cooling-feeds" })}
        onCancel={() => nav({ to: "/cooling-feeds" })}
      />
    </EditPageShell>
  )
}
