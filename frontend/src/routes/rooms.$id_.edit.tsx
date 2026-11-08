import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Room } from "@/lib/api"
import { RoomForm } from "@/components/room-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/rooms/$id_/edit")({
  component: EditRoomPage,
})

function EditRoomPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ["room", id],
    queryFn: () => api<Room>(`/api/rooms/${id}/`),
  })
  const backToDetail = () => nav({ to: "/rooms/$id", params: { id } })

  return (
    <EditPageShell
      wide
      crumbs={[
        { label: "Rooms", to: "/rooms" },
        q.data
          ? { label: q.data.name, to: "/rooms/$id", params: { id } }
          : { label: "…" },
        { label: "Edit" },
      ]}
      title={q.data ? `Edit ${q.data.name}` : "Edit room"}
    >
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <RoomForm
          room={q.data}
          onSaved={backToDetail}
          onCancel={backToDetail}
        />
      )}
    </EditPageShell>
  )
}
