import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Box, PanelRight, Waypoints } from "lucide-react"

import { api } from "@/lib/api"
import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTilePanel,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { StatusBadge } from "@/components/status-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { BarButton } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import { Badge } from "@/components/ui/badge"

import { endText } from "./cable-draw"
import { tileName } from "./floor-canvas"

/** A device or rack tile's panel payload. */
export function useTilePanel(
  planId: string,
  tileId: string | null,
  deviceId?: string
) {
  return useQuery({
    queryKey: ["floor-plan-tile-panel", planId, tileId, deviceId ?? null],
    queryFn: () =>
      api<FloorPlanTilePanel>(
        `/api/floor-plans/${planId}/tile-panel/${tileId}/` +
          (deviceId ? `?device=${deviceId}` : "")
      ),
    enabled: !!tileId,
    staleTime: 30_000,
  })
}

/** The plan's cables with an end on this tile - a device's own, or a
 * rack's devices'. */
export function tileCables(
  tile: FloorPlanTile,
  cablePaths: readonly FloorPlanCablePath[]
): FloorPlanCablePath[] {
  return cablePaths.filter(
    (cp) => cp.a_tiles.includes(tile.id) || cp.b_tiles.includes(tile.id)
  )
}

/** The end of `cp` away from `tile`, as text. */
function otherEnd(cp: FloorPlanCablePath, tile: FloorPlanTile): string {
  const atA = cp.a_tiles.includes(tile.id)
  const pts = atA
    ? cp.b_points.length
      ? cp.b_points
      : (cp.b_far ?? [])
    : cp.a_points.length
      ? cp.a_points
      : (cp.a_far ?? [])
  return endText(pts)
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/**
 * What a device or rack tile opens while viewing: the object's facts, its
 * monitoring, a device's ports, a rack's devices by U, and the plan's
 * cables on it - each opens the cable panel and traces it.
 */
export function ObjectDetailPanel({
  planId,
  tile,
  deviceId,
  cablePaths,
  onClose,
  onPickCable,
  onOpen3d,
  onContents,
}: {
  planId: string
  tile: FloorPlanTile
  /** One of a rack tile's devices (picked in the 3D room). */
  deviceId?: string
  cablePaths: readonly FloorPlanCablePath[]
  onClose: () => void
  onPickCable: (cableId: string) => void
  /** Open the 3D room on this object; left out in 3D. */
  onOpen3d?: () => void
  /** The contents and end-to-end paths sheet. */
  onContents?: () => void
}) {
  const kind = tile.linked?.kind === "rack" && !deviceId ? "rack" : "device"
  const q = useTilePanel(planId, tile.id, deviceId)
  const p = q.data
  const fromPanel =
    p && !p.hidden ? (p.kind === "device" ? p.device : p.rack) : null
  const name =
    fromPanel?.name || tileName(tile) || tile.linked?.name || "Object"
  const id = deviceId ?? (tile.linked?.hidden ? null : tile.linked?.id)
  // A racked device: the cables on its own ports.
  const cables = deviceId
    ? cablePaths.filter((cp) =>
        [...cp.a_points, ...cp.b_points].some((e) => e.device === deviceId)
      )
    : tileCables(tile, cablePaths)
  return (
    <PanelShell
      label={kind === "rack" ? "Rack" : "Device"}
      title={name}
      titleText={name}
      onClose={onClose}
      footer={
        id && (
          <>
            {kind === "rack" ? (
              <OpenLink to="/racks/$id" params={{ id }}>
                Open rack
              </OpenLink>
            ) : (
              <OpenLink to="/devices/$id" params={{ id }}>
                Open device
              </OpenLink>
            )}
            {onOpen3d && (
              <BarButton onClick={onOpen3d}>
                <Box /> 3D
              </BarButton>
            )}
          </>
        )
      }
    >
      {q.isError ? (
        <QueryError error={q.error} />
      ) : !p ? (
        <Loading className="min-h-24" />
      ) : p.hidden ? (
        <span className="text-muted-foreground">Hidden</span>
      ) : p.kind === "device" ? (
        <DeviceBody p={p} onContents={onContents} />
      ) : (
        <RackBody p={p} onContents={onContents} />
      )}
      {p && !p.hidden && (
        <PanelSection label="Cables on this plan">
          {cables.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <ul className="grid gap-0.5">
              {cables.map((cp) => (
                <li key={cp.id}>
                  <button
                    type="button"
                    data-panel-cable={cp.id}
                    onClick={() => onPickCable(cp.id)}
                    className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted"
                  >
                    <span className="min-w-0 truncate font-mono">
                      {cp.label || "Cable"}
                    </span>
                    <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
                      {otherEnd(cp, tile)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      )}
    </PanelShell>
  )
}

type DevicePanel = Extract<
  FloorPlanTilePanel,
  { kind: "device"; device: unknown }
>
type RackPanel = Extract<FloorPlanTilePanel, { kind: "rack"; rack: unknown }>

function DeviceBody({
  p,
  onContents,
}: {
  p: DevicePanel
  onContents?: () => void
}) {
  const d = p.device
  const ips = [
    ["Primary IP", d.primary_ip],
    ["Secondary IP", d.secondary_ip],
    ["OOB IP", d.oob_ip],
  ] as const
  const where = [
    d.site?.name,
    d.location?.name,
    d.rack
      ? `${d.rack.name}${d.position != null ? ` · U${d.position}` : ""}`
      : d.cabinet?.name,
  ].filter(Boolean)
  const m = p.monitoring
  const ports = p.ports
  return (
    <>
      <PanelSection label="Device">
        {d.role && (
          <PanelRow label="Role">
            <ColorBadge name={d.role.name} color={d.role.color || undefined} />
          </PanelRow>
        )}
        <PanelRow label="Status">
          <StatusBadge status={d.status} />
        </PanelRow>
        {d.device_type && (
          <PanelRow label="Type">
            {[d.device_type.manufacturer, d.device_type.model]
              .filter(Boolean)
              .join(" ")}
          </PanelRow>
        )}
        {d.platform && <PanelRow label="Platform">{d.platform.name}</PanelRow>}
        {d.serial_number && (
          <PanelRow label="Serial">
            <span className="font-mono">{d.serial_number}</span>
          </PanelRow>
        )}
        {d.asset_tag && (
          <PanelRow label="Asset tag">
            <span className="font-mono">{d.asset_tag}</span>
          </PanelRow>
        )}
        {where.length > 0 && (
          <PanelRow label="Where">{where.join(" · ")}</PanelRow>
        )}
        {ips.map(([label, ip]) =>
          ip ? (
            <PanelRow key={label} label={label}>
              <span className="font-mono">{ip.ip_address}</span>
            </PanelRow>
          ) : null
        )}
        {d.tenant && <PanelRow label="Tenant">{d.tenant.name}</PanelRow>}
        {d.profiles.length > 0 && (
          <PanelRow label="Profiles">
            <span className="inline-flex flex-wrap justify-end gap-1">
              {d.profiles.map((pr) => (
                <ColorBadge
                  key={pr.id}
                  name={pr.name}
                  color={pr.color || undefined}
                  className="h-4 px-1.5 text-[10px]"
                />
              ))}
            </span>
          </PanelRow>
        )}
        {d.tags.length > 0 && (
          <PanelRow label="Tags">
            <span className="inline-flex flex-wrap justify-end gap-1">
              {d.tags.map((t) => (
                <ColorBadge
                  key={t.id}
                  name={t.name}
                  color={t.color || undefined}
                  className="h-4 px-1.5 text-[10px]"
                />
              ))}
            </span>
          </PanelRow>
        )}
      </PanelSection>
      <PanelSection label="Monitoring">
        {!m.status ? (
          <span className="text-muted-foreground">No checks</span>
        ) : (
          <>
            <PanelRow label="State">
              <CheckStatusBadge status={m.status} />
            </PanelRow>
            <ul className="mt-1 grid gap-0.5">
              {m.checks.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 text-[11px]"
                  data-check={c.id}
                >
                  <CheckStatusBadge
                    status={c.status}
                    className="h-4 shrink-0 px-1.5 text-[10px]"
                  />
                  <span className="min-w-0 truncate">{c.name}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {c.last_checked ? (
                      <TimeCell iso={c.last_checked} align="right" />
                    ) : (
                      "-"
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </PanelSection>
      <PanelSection label="Ports">
        <PanelRow label="Interfaces">
          <span className="num">{ports.total}</span>
        </PanelRow>
        <PanelRow label="Connected">
          <span className="num">
            {ports.connected} / {ports.total}
          </span>
        </PanelRow>
        {ports.observed && (
          <PanelRow label="Live">
            <span className="inline-flex gap-1">
              <Badge variant="success">{ports.up ?? 0} up</Badge>
              {!!ports.down && (
                <Badge variant="destructive">{ports.down} down</Badge>
              )}
            </span>
          </PanelRow>
        )}
        {ports.disabled > 0 && (
          <PanelRow label="Disabled">
            <span className="num">{ports.disabled}</span>
          </PanelRow>
        )}
        {onContents && (
          <BarButton className="mt-1.5 w-full" onClick={onContents}>
            <Waypoints /> Paths
          </BarButton>
        )}
        {d.rack && (
          <BarButton asChild className="mt-1.5 w-full">
            <Link to="/racks/$id" params={{ id: d.rack.id }}>
              <PanelRight /> Rack view
            </Link>
          </BarButton>
        )}
      </PanelSection>
    </>
  )
}

function RackBody({
  p,
  onContents,
}: {
  p: RackPanel
  onContents?: () => void
}) {
  const r = p.rack
  return (
    <>
      <PanelSection label="Rack">
        {r.role && (
          <PanelRow label="Role">
            <ColorBadge name={r.role.name} color={r.role.color || undefined} />
          </PanelRow>
        )}
        <PanelRow label="Status">
          <StatusBadge status={r.status} />
        </PanelRow>
        {r.rack_type && <PanelRow label="Type">{r.rack_type.name}</PanelRow>}
        {r.facility_id && (
          <PanelRow label="Facility ID">
            <span className="font-mono">{r.facility_id}</span>
          </PanelRow>
        )}
        {(r.site || r.location) && (
          <PanelRow label="Where">
            {[r.site?.name, r.location?.name].filter(Boolean).join(" · ")}
          </PanelRow>
        )}
        <PanelRow label="Space">
          <span className="num">
            {p.used_units} / {r.u_height}U
          </span>
        </PanelRow>
        {p.monitoring.status && (
          <PanelRow label="Monitoring">
            <CheckStatusBadge status={p.monitoring.status} />
          </PanelRow>
        )}
        {r.tags.length > 0 && (
          <PanelRow label="Tags">
            <span className="inline-flex flex-wrap justify-end gap-1">
              {r.tags.map((t) => (
                <ColorBadge
                  key={t.id}
                  name={t.name}
                  color={t.color || undefined}
                  className="h-4 px-1.5 text-[10px]"
                />
              ))}
            </span>
          </PanelRow>
        )}
      </PanelSection>
      <PanelSection label={`Devices · ${p.devices.length}`}>
        {p.devices.length === 0 ? (
          <span className="text-muted-foreground">Empty</span>
        ) : (
          <ul className="grid gap-0.5">
            {p.devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2"
                data-rack-device={d.id}
              >
                <span className="num w-9 shrink-0 text-right text-[11px] text-muted-foreground">
                  {d.position != null ? `U${d.position}` : "-"}
                </span>
                <Link
                  to="/devices/$id"
                  params={{ id: d.id }}
                  className="link min-w-0 truncate font-mono"
                >
                  {d.name}
                </Link>
                <span className="ml-auto flex shrink-0 gap-1">
                  {d.check && (
                    <CheckStatusBadge
                      status={d.check}
                      className="h-4 px-1.5 text-[10px]"
                    />
                  )}
                  {d.status && (
                    <StatusBadge
                      status={d.status}
                      className="h-4 px-1.5 text-[10px]"
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {p.hidden_count > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {plural(p.hidden_count, "hidden device")}
          </p>
        )}
        {onContents && (
          <BarButton className="mt-1.5 w-full" onClick={onContents}>
            <PanelRight /> Contents & trace
          </BarButton>
        )}
      </PanelSection>
    </>
  )
}
