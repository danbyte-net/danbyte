import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Box, PanelRight, Waypoints } from "lucide-react"

import { api } from "@/lib/api"
import type {
  CabinetTilePanel,
  DeviceTilePanel,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTilePanel,
  PanelContentDevice,
  PanelLayoutItem,
  RackTilePanel,
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

/** A device, rack or cabinet tile's panel payload. */
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
 * rack's or cabinet's devices'. */
export function tileCables(
  tile: FloorPlanTile,
  cablePaths: readonly FloorPlanCablePath[]
): FloorPlanCablePath[] {
  return cablePaths.filter(
    (cp) => cp.a_tiles.includes(tile.id) || cp.b_tiles.includes(tile.id)
  )
}

/** The end of `cp` away from the tile (or device) it was listed for. */
function otherEnd(cp: FloorPlanCablePath, atA: boolean): string {
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

const OPEN = {
  device: { to: "/devices/$id", label: "Open device" },
  rack: { to: "/racks/$id", label: "Open rack" },
  cabinet: { to: "/cabinets/$id", label: "Open cabinet" },
} as const

const LABEL = { device: "Device", rack: "Rack", cabinet: "Cabinet" } as const

/**
 * What a device, rack or cabinet tile opens while viewing: the fields its
 * layout names (Settings → Floor plans → Detail panels), in its order, in
 * its sections - a field with nothing to say is left out, and so is a
 * section left empty. The plan's cables on it open the cable panel.
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
  /** One of a rack's or cabinet's devices (picked in the 3D room). */
  deviceId?: string
  cablePaths: readonly FloorPlanCablePath[]
  onClose: () => void
  onPickCable: (cableId: string) => void
  /** Open the 3D room on this object; left out in 3D. */
  onOpen3d?: () => void
  /** The contents and end-to-end paths. */
  onContents?: () => void
}) {
  const linkKind = tile.linked?.kind
  const kind =
    !deviceId && (linkKind === "rack" || linkKind === "cabinet")
      ? linkKind
      : "device"
  const q = useTilePanel(planId, tile.id, deviceId)
  const p = q.data
  const name =
    (p && !p.hidden ? panelObject(p).name : null) ||
    tileName(tile) ||
    tile.linked?.name ||
    "Object"
  const id = deviceId ?? (tile.linked?.hidden ? null : tile.linked?.id)
  // A device in a rack or cabinet: the cables on its own ports.
  const cables: TileCable[] = deviceId
    ? cablePaths.flatMap((cp) => {
        const atA = cp.a_points.some((e) => e.device === deviceId)
        const atB = cp.b_points.some((e) => e.device === deviceId)
        return atA || atB ? [{ cp, atA }] : []
      })
    : tileCables(tile, cablePaths).map((cp) => ({
        cp,
        atA: cp.a_tiles.includes(tile.id),
      }))
  return (
    <PanelShell
      label={LABEL[kind]}
      title={name}
      titleText={name}
      onClose={onClose}
      footer={
        id && (
          <>
            <OpenLink to={OPEN[kind].to} params={{ id }}>
              {OPEN[kind].label}
            </OpenLink>
            {p?.kind === "device" && !p.hidden && p.device.rack && (
              <BarButton asChild>
                <Link to="/racks/$id" params={{ id: p.device.rack.id }}>
                  <PanelRight /> Rack
                </Link>
              </BarButton>
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
      ) : (
        <PanelLayoutBody
          p={p}
          cables={cables}
          onPickCable={onPickCable}
          onContents={onContents}
        />
      )}
    </PanelShell>
  )
}

export interface TileCable {
  cp: FloorPlanCablePath
  /** The object is the cable's A end. */
  atA: boolean
}

type ShownPanel = DeviceTilePanel | RackTilePanel | CabinetTilePanel

function panelObject(p: ShownPanel): { name: string } {
  return p.kind === "device" ? p.device : p.kind === "rack" ? p.rack : p.cabinet
}

/** A layout's entries as sections: a heading and its fields. Fields before
 * the first heading form a section with none. */
export function layoutSections(
  items: readonly PanelLayoutItem[]
): { label: string; keys: string[] }[] {
  const out: { label: string; keys: string[] }[] = []
  for (const it of items) {
    if ("section" in it) out.push({ label: it.section, keys: [] })
    else {
      if (!out.length) out.push({ label: "", keys: [] })
      out[out.length - 1].keys.push(it.field)
    }
  }
  return out
}

/** The panel's body as its layout says - shared with the settings
 * preview. `cables` are the plan's cables on the object (none in the
 * preview, which has no plan). */
export function PanelLayoutBody({
  p,
  cables,
  onPickCable,
  onContents,
}: {
  p: ShownPanel
  cables?: TileCable[]
  onPickCable?: (cableId: string) => void
  onContents?: () => void
}) {
  const ctx: FieldCtx = { p, cables, onPickCable, onContents }
  const sections = layoutSections(p.layout.items)
    .map((s) => ({
      label: s.label,
      nodes: s.keys
        .map((k) => ({ k, node: renderField(k, ctx) }))
        .filter((x) => x.node != null),
    }))
    .filter((s) => s.nodes.length)
  return (
    <>
      {sections.map((s, i) => {
        const body = s.nodes.map((x) => <div key={x.k}>{x.node}</div>)
        return s.label ? (
          <PanelSection key={i} label={s.label}>
            {body}
          </PanelSection>
        ) : (
          <div key={i} className="mt-2 first:mt-0">
            {body}
          </div>
        )
      })}
    </>
  )
}

interface FieldCtx {
  p: ShownPanel
  cables?: TileCable[]
  onPickCable?: (cableId: string) => void
  onContents?: () => void
}

const pill = "h-4 px-1.5 text-[10px]"

function Pills({
  items,
}: {
  items: { id: string | number; name: string; color: string }[]
}) {
  if (!items.length) return null
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      {items.map((t) => (
        <ColorBadge
          key={t.id}
          name={t.name}
          color={t.color || undefined}
          className={pill}
        />
      ))}
    </span>
  )
}

const mono = (v: string) => <span className="font-mono">{v}</span>

/** One field of a layout, or null when it has nothing to say. */
function renderField(key: string, ctx: FieldCtx): React.ReactNode {
  const { p } = ctx
  if (key.startsWith("cf:")) {
    const cf = p.custom_fields.find((c) => c.key === key.slice(3))
    return cf ? <PanelRow label={cf.label}>{cf.value}</PanelRow> : null
  }
  if (key === "cables") return <CablesBlock ctx={ctx} />
  const o =
    p.kind === "device" ? p.device : p.kind === "rack" ? p.rack : p.cabinet
  const row = (label: string, v: React.ReactNode) =>
    v == null || v === "" || v === false ? null : (
      <PanelRow label={label}>{v}</PanelRow>
    )
  switch (key) {
    case "role":
      return (
        o.role &&
        row(
          "Role",
          <ColorBadge name={o.role.name} color={o.role.color || undefined} />
        )
      )
    case "status":
      return o.status && row("Status", <StatusBadge status={o.status} />)
    case "site":
      return row("Site", o.site?.name)
    case "location":
      return row("Location", o.location?.name)
    case "tenant":
      return row("Tenant", o.tenant?.name)
    case "tags":
      return o.tags.length ? row("Tags", <Pills items={o.tags} />) : null
    case "description":
      return row("Description", o.description)
    case "numid":
      return o.numid != null ? row("ID", mono(`#${o.numid}`)) : null
    case "facility_id":
      return "facility_id" in o && o.facility_id
        ? row("Facility ID", mono(o.facility_id))
        : null
  }
  if (p.kind === "device") return deviceField(key, p, ctx, row)
  if (p.kind === "rack") return rackField(key, p, ctx, row)
  return cabinetField(key, p, ctx, row)
}

type Row = (label: string, v: React.ReactNode) => React.ReactNode

function deviceField(
  key: string,
  p: DeviceTilePanel,
  ctx: FieldCtx,
  row: Row
): React.ReactNode {
  const d = p.device
  switch (key) {
    case "device_type":
      return (
        d.device_type &&
        row(
          "Type",
          [d.device_type.manufacturer, d.device_type.model]
            .filter(Boolean)
            .join(" ")
        )
      )
    case "platform":
      return row("Platform", d.platform?.name)
    case "software_version":
      return row("Software", d.software_version)
    case "serial_number":
      return d.serial_number ? row("Serial", mono(d.serial_number)) : null
    case "asset_tag":
      return d.asset_tag ? row("Asset tag", mono(d.asset_tag)) : null
    case "position":
      return d.rack
        ? row(
            "Rack",
            `${d.rack.name}${d.position != null ? ` · U${d.position}` : ""}`
          )
        : d.cabinet
          ? row("Cabinet", d.cabinet.name)
          : null
    case "primary_ip":
      return d.primary_ip
        ? row("Primary IP", mono(d.primary_ip.ip_address))
        : null
    case "secondary_ip":
      return d.secondary_ip
        ? row("Secondary IP", mono(d.secondary_ip.ip_address))
        : null
    case "oob_ip":
      return d.oob_ip ? row("OOB IP", mono(d.oob_ip.ip_address)) : null
    case "profiles":
      return d.profiles.length
        ? row("Profiles", <Pills items={d.profiles} />)
        : null
    case "monitoring":
      return p.monitoring ? <DeviceMonitoring m={p.monitoring} /> : null
    case "ports":
      return p.ports ? (
        <DevicePorts ports={p.ports} onContents={ctx.onContents} />
      ) : null
    case "ips":
      return p.ips?.length ? (
        <ul className="grid gap-0.5" data-panel-ips>
          {p.ips.map((ip) => (
            <li key={ip.id} className="flex items-baseline gap-2">
              <span className="font-mono">{ip.ip_address}</span>
              <span className="ml-auto truncate text-[11px] text-muted-foreground">
                {ip.interface}
              </span>
            </li>
          ))}
        </ul>
      ) : null
  }
  return null
}

function rackField(
  key: string,
  p: RackTilePanel,
  ctx: FieldCtx,
  row: Row
): React.ReactNode {
  const r = p.rack
  switch (key) {
    case "rack_type":
      return row("Type", r.rack_type?.name)
    case "space":
      return row(
        "Space",
        <span className="num">
          {p.used_units} / {r.u_height}U
        </span>
      )
    case "monitoring":
      return p.monitoring.status
        ? row("Monitoring", <CheckStatusBadge status={p.monitoring.status} />)
        : null
    case "devices":
      return (
        <ContentsBlock
          devices={p.devices}
          hidden={p.hidden_count}
          place={(d) => (d.position != null ? `U${d.position}` : "-")}
          contents="Contents & trace"
          onContents={ctx.onContents}
        />
      )
  }
  return null
}

function cabinetField(
  key: string,
  p: CabinetTilePanel,
  ctx: FieldCtx,
  row: Row
): React.ReactNode {
  const c = p.cabinet
  switch (key) {
    case "cabinet_type":
      return row("Type", c.cabinet_type?.name)
    case "size":
      return c.size_mm
        ? row("Size", <span className="num">{c.size_mm.join(" × ")} mm</span>)
        : null
    case "monitoring":
      return p.monitoring.status
        ? row("Monitoring", <CheckStatusBadge status={p.monitoring.status} />)
        : null
    case "devices":
      return (
        <ContentsBlock
          devices={p.devices}
          hidden={p.hidden_count}
          place={(d) => d.rail || "-"}
          contents="Plate & trace"
          onContents={ctx.onContents}
        />
      )
  }
  return null
}

function DeviceMonitoring({
  m,
}: {
  m: NonNullable<DeviceTilePanel["monitoring"]>
}) {
  if (!m.status) return <span className="text-muted-foreground">No checks</span>
  return (
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
              className={`${pill} shrink-0`}
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
  )
}

function DevicePorts({
  ports,
  onContents,
}: {
  ports: NonNullable<DeviceTilePanel["ports"]>
  onContents?: () => void
}) {
  return (
    <>
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
    </>
  )
}

function ContentsBlock({
  devices,
  hidden,
  place,
  contents,
  onContents,
}: {
  devices: PanelContentDevice[]
  hidden: number
  place: (d: PanelContentDevice) => string
  contents: string
  onContents?: () => void
}) {
  return (
    <>
      {devices.length === 0 ? (
        <span className="text-muted-foreground">Empty</span>
      ) : (
        <ul className="grid gap-0.5">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-2"
              data-rack-device={d.id}
            >
              <span className="num w-9 shrink-0 truncate text-right text-[11px] text-muted-foreground">
                {place(d)}
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
                  <CheckStatusBadge status={d.check} className={pill} />
                )}
                {d.status && <StatusBadge status={d.status} className={pill} />}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {plural(hidden, "hidden device")}
        </p>
      )}
      {onContents && (
        <BarButton className="mt-1.5 w-full" onClick={onContents}>
          <PanelRight /> {contents}
        </BarButton>
      )}
    </>
  )
}

function CablesBlock({ ctx }: { ctx: FieldCtx }) {
  const { cables, onPickCable } = ctx
  if (!cables) return null
  if (!cables.length) return <span className="text-muted-foreground">None</span>
  return (
    <ul className="grid gap-0.5">
      {cables.map(({ cp, atA }) => (
        <li key={cp.id}>
          <button
            type="button"
            data-panel-cable={cp.id}
            onClick={() => onPickCable?.(cp.id)}
            className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted"
          >
            <span className="min-w-0 truncate font-mono">
              {cp.label || "Cable"}
            </span>
            <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
              {otherEnd(cp, atA)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
