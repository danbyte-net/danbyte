import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { RoomForm } from "@/components/room-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { planSearch } from "@/lib/save-object"
import type { PlanSearch } from "@/lib/save-object"

export const Route = createFileRoute("/rooms/new")({
  // ?site=&location= pre-pick both - how a location's "Add room" lands here.
  validateSearch: (
    s: Record<string, unknown>
  ): { site?: string; location?: string } & PlanSearch => ({
    site: typeof s.site === "string" ? s.site : undefined,
    location: typeof s.location === "string" ? s.location : undefined,
    ...planSearch(s),
  }),
  component: NewRoomPage,
})

function NewRoomPage() {
  const nav = useNavigate()
  const { site, location } = Route.useSearch()
  return (
    <EditPageShell
      wide
      crumbs={[{ label: "Rooms", to: "/rooms" }, { label: "Add" }]}
      title="Add room"
      subtitle="A room inside a location."
    >
      <RoomForm
        initialSiteId={site}
        initialLocationId={location}
        onSaved={(r) => nav({ to: "/rooms/$id", params: { id: r.id } })}
        onCancel={() => nav({ to: "/rooms" })}
      />
    </EditPageShell>
  )
}
