import { createFileRoute, useNavigate } from "@tanstack/react-router"

import type { TerminationKind } from "@/lib/api"
import { CableForm } from "@/components/cable-form"
import { EditPageShell } from "@/components/edit-page-shell"

const KINDS: TerminationKind[] = [
  "interface",
  "front_port",
  "rear_port",
  "console_port",
  "console_server_port",
  "power_port",
  "power_outlet",
  "power_feed",
  "aux_port",
]

export const Route = createFileRoute("/cables/new")({
  // `?a_kind=interface&a_id=<uuid>` pre-seeds the A side, so "Connect cable"
  // buttons land here with the port already picked. Keys omitted when absent
  // so plain navigation stays valid.
  validateSearch: (
    search: Record<string, unknown>
  ): { a_kind?: TerminationKind; a_id?: string } => {
    const kind = KINDS.find((k) => k === search.a_kind)
    if (kind && typeof search.a_id === "string")
      return { a_kind: kind, a_id: search.a_id }
    return {}
  },
  component: NewCablePage,
})

function NewCablePage() {
  const nav = useNavigate()
  const { a_kind, a_id } = Route.useSearch()
  return (
    <EditPageShell
      crumbs={[{ label: "Cables", to: "/cables" }, { label: "Add" }]}
      title="Add cable"
      subtitle="A physical connection between two interfaces."
    >
      <CableForm
        initialA={a_kind && a_id ? [{ kind: a_kind, id: a_id }] : undefined}
        onSaved={(c) => nav({ to: "/cables/$id", params: { id: c.id } })}
        onCancel={() => nav({ to: "/cables" })}
      />
    </EditPageShell>
  )
}
