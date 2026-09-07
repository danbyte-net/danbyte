import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"

import type { TerminationKind } from "@/lib/api"
import { safeReturnPath } from "@/lib/return-url"
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
  ): { a_kind?: TerminationKind; a_id?: string; ret?: string } => {
    const ret = safeReturnPath(search.ret)
    const kind = KINDS.find((k) => k === search.a_kind)
    if (kind && typeof search.a_id === "string")
      return { a_kind: kind, a_id: search.a_id, ...(ret ? { ret } : {}) }
    return ret ? { ret } : {}
  },
  component: NewCablePage,
})

function NewCablePage() {
  const nav = useNavigate()
  const router = useRouter()
  const { a_kind, a_id, ret } = Route.useSearch()
  // `?ret=` (issue #76): opened from a device tab, save/cancel go back there
  // instead of the cables list - the tab shows the new cable immediately.
  const done = (cableId?: string) => {
    // The port just left whatever cabled-state bucket the caller was
    // filtered to (reserved/free -> connected), so returning into that
    // filter would land on a list the port is no longer in.
    const back = ret ? ret.replace(/([?&])cabled=[^&]*(&|$)/, "$1") : ret
    if (back) router.history.push(back.replace(/[?&]$/, ""))
    else if (cableId) void nav({ to: "/cables/$id", params: { id: cableId } })
    else void nav({ to: "/cables" })
  }
  return (
    <EditPageShell
      wide
      crumbs={[{ label: "Cables", to: "/cables" }, { label: "Add" }]}
      title="Add cable"
      subtitle="A physical connection between two interfaces."
    >
      <CableForm
        initialA={a_kind && a_id ? [{ kind: a_kind, id: a_id }] : undefined}
        onSaved={(c) => done(c.id)}
        onCancel={() => done()}
      />
    </EditPageShell>
  )
}
