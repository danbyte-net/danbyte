import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Room } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { Loading } from "@/components/loading"
import { PanelRow, PanelShell } from "@/components/map-panel"
import { OpenLink } from "@/components/open-link"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"

import { areaColor, areaName } from "./shapes"
import type { AreaShape } from "./shapes"

/** An area clicked while viewing: the room it is drawn for (code, status,
 * location, what stands in it) with a link to the room, or the location. */
export function AreaPanel({
  area,
  onClose,
}: {
  area: AreaShape
  onClose: () => void
}) {
  const roomId = area.room?.id
  const room = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api<Room>(`/api/rooms/${roomId}/`),
    enabled: !!roomId,
  })
  const name = areaName(area) || "Area"
  return (
    <PanelShell
      label={roomId ? "Room" : "Area"}
      title={
        <ColorBadge name={name} color={areaColor(area)} className="max-w-64" />
      }
      titleText={name}
      onClose={onClose}
      footer={
        roomId ? (
          <OpenLink to="/rooms/$id" params={{ id: roomId }}>
            Open room
          </OpenLink>
        ) : area.location ? (
          <OpenLink to="/locations/$id" params={{ id: area.location.id }}>
            Open location
          </OpenLink>
        ) : undefined
      }
    >
      {roomId && room.isLoading && <Loading />}
      {roomId && room.isError && <QueryError error={room.error} />}
      {room.data && (
        <>
          {room.data.code && (
            <PanelRow label="Code">
              <span className="font-mono">{room.data.code}</span>
            </PanelRow>
          )}
          {room.data.status && (
            <PanelRow label="Status">
              <StatusBadge status={room.data.status} />
            </PanelRow>
          )}
          <PanelRow label="Location">
            <ColorBadge
              name={room.data.location.name}
              color={room.data.location.color || undefined}
            />
          </PanelRow>
          <PanelRow label="Devices">
            <span className="num">{room.data.device_count}</span>
          </PanelRow>
          <PanelRow label="Racks">
            <span className="num">{room.data.rack_count}</span>
          </PanelRow>
          <PanelRow label="Cabinets">
            <span className="num">{room.data.cabinet_count}</span>
          </PanelRow>
          {room.data.description && (
            <p className="mt-2 text-muted-foreground">
              {room.data.description}
            </p>
          )}
        </>
      )}
      {!roomId && area.location && (
        <PanelRow label="Location">
          <ColorBadge
            name={area.location.name}
            color={area.location.color || undefined}
          />
        </PanelRow>
      )}
      {!roomId && !area.location && (
        <p className="text-muted-foreground">Not linked to a room.</p>
      )}
    </PanelShell>
  )
}
