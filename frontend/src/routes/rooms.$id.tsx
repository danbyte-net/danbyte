import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { Room } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { CustomFieldValues } from "@/components/custom-field-display"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { ObjectImages } from "@/components/object-images"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import { RoomDeleteDialog } from "@/components/room-delete-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { EmbeddedDeviceTable } from "@/components/embedded-device-table"
import {
  EmbeddedCabinetTable,
  EmbeddedRackTable,
} from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/rooms/$id")({
  component: RoomDetail,
})

function RoomDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["room", id],
    queryFn: () => api<Room>(`/api/rooms/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body room={q.data} />
}

function Body({ room: r }: { room: Room }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "devices" | "racks" | "cabinets" | "journal" | "history"
  >("overview")
  const { canDo } = useMe()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Room | null>(null)
  const openDelete = useCallback(() => setDeleting(r), [r])
  const goBack = useCallback(() => nav({ to: "/rooms" }), [nav])

  return (
    <DetailShell
      backTo="/rooms"
      backLabel="Rooms"
      title={r.name}
      presence={{ type: "room", id: r.id }}
      actions={
        <>
          {canDo("room", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/rooms/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("room", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={openDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={r.name}
          badges={<StatusBadge status={r.status} />}
          subtitle={r.code && <span className="font-mono">{r.code}</span>}
          tags={r.tags.length > 0 && <TagList tags={r.tags} listTo="/rooms" />}
          description={r.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices", count: r.device_count },
        { value: "racks", label: "Racks", count: r.rack_count },
        { value: "cabinets", label: "Cabinets", count: r.cabinet_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <RoomOverview room={r} />
      </DetailTab>
      <DetailTab value="devices">
        <EmbeddedDeviceTable
          filter={{ room: r.id }}
          emptyText="No devices in this room yet."
        />
      </DetailTab>
      <DetailTab value="racks">
        <EmbeddedRackTable
          filter={{ room: r.id }}
          emptyText="No racks in this room yet."
        />
      </DetailTab>
      <DetailTab value="cabinets">
        <EmbeddedCabinetTable
          filter={{ room: r.id }}
          omit={["site", "location", "room"]}
          emptyText="No cabinets in this room yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.room" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.room" objectId={r.id} />
      </DetailTab>

      <RoomDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The room's attributes beside its custom fields, then its photos. */
function RoomOverview({ room: r }: { room: Room }) {
  const { humanIds } = useMe()
  const rows: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Code", value: mono(r.code) },
    {
      label: "Site",
      value: (
        <Link to="/sites/$id" params={{ id: r.site.id }} className="link">
          {r.site.name}
        </Link>
      ),
    },
    {
      label: "Location",
      value: (
        <Link
          to="/locations/$id"
          params={{ id: r.location.id }}
          className="link"
        >
          {r.location.name}
        </Link>
      ),
    },
    { label: "Status", value: <StatusBadge status={r.status} /> },
    {
      label: "Color",
      value: r.color ? <ColorBadge name={r.name} color={r.color} /> : dash,
    },
  ]
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Room" rows={rows} />
        <CustomFieldValues
          model="room"
          values={r.custom_fields}
          layout="cards"
        />
      </div>
      <ObjectImages apiBase={`/api/rooms/${r.id}`} objectType="room" />
    </div>
  )
}
