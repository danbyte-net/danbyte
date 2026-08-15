import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { type VRF } from "@/lib/api"
import { VrfForm } from "@/components/vrf-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { useCloneSeed } from "@/lib/use-clone"

export const Route = createFileRoute("/vrfs/new")({
  validateSearch: (s: Record<string, unknown>) => ({
    ...(typeof s.clone === "string" ? { clone: s.clone } : {}),
  }),
  component: NewVrfPage,
})

function NewVrfPage() {
  const { clone } = Route.useSearch()
  const nav = useNavigate()
  const cloneQ = useCloneSeed<Partial<VRF>>("vrfs", clone)
  const cloning = !!clone
  return (
    <EditPageShell
      crumbs={[
        { label: "VRFs", to: "/vrfs" },
        { label: cloning ? "Clone" : "Add" },
      ]}
      title={cloning ? "Clone VRF" : "Add VRF"}
      subtitle={
        cloning
          ? "Route targets, color and description carried over — pick a new name and RD."
          : "Register a new routing context."
      }
    >
      {cloning && cloneQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <VrfForm
          clone={cloning ? cloneQ.data?.initial : undefined}
          onSaved={(v) => nav({ to: "/vrfs/$id", params: { id: v.id } })}
          onCancel={() => nav({ to: "/vrfs" })}
        />
      )}
    </EditPageShell>
  )
}
