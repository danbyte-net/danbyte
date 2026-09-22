import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ConfigBundleForm } from "@/components/config-bundle-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/config-bundles/new")({
  component: NewConfigBundlePage,
})

function NewConfigBundlePage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "Config bundles", to: "/config-bundles" },
        { label: "Add" },
      ]}
      title="Add config bundle"
      subtitle="The set of files a device role needs, rendered together."
    >
      <ConfigBundleForm
        onSaved={(b) =>
          nav({ to: "/config-bundles/$id", params: { id: b.id } })
        }
        onCancel={() => nav({ to: "/config-bundles" })}
      />
    </EditPageShell>
  )
}
