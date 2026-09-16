import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EditPageShell } from "@/components/edit-page-shell"
import { CommunityListForm } from "@/components/routing/list-forms"

export const Route = createFileRoute("/community-lists/new")({
  component: NewPage,
})

function NewPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Community lists", to: "/community-lists" },
        { label: "Add" },
      ]}
      title="Add community list"
      subtitle="A named set of communities a policy matches on."
    >
      <CommunityListForm
        onSaved={(v) =>
          nav({ to: "/community-lists/$id", params: { id: v.id } })
        }
        onCancel={() => nav({ to: "/community-lists" })}
      />
    </EditPageShell>
  )
}
