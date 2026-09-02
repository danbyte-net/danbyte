import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import {
  Cable as CableIcon,
  EyeOff,
  Pencil,
  Unplug,
  Waypoints,
  Workflow,
  Layers,
} from "lucide-react"

import { DriftBadge } from "@/components/drift-detail"
import { InterfaceDriftMarker } from "@/components/monitoring/device-drift-badge"
import type { InterfaceDriftEntry } from "@/components/monitoring/device-drift-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import type { PlannedTargetRow } from "@/components/planning/planned-change-badge"

import { api } from "@/lib/api"
import type { Cable, Interface, SnmpDriftItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { CableStatusControl } from "@/components/cable-status-control"
import { CableDeleteDialog } from "@/components/cable-delete-dialog"
import {
  MarkConnectedToggle,
  PortReserveAction,
  ReservedBadge,
  UndocumentedBadge,
} from "@/components/port-reservation-dialog"
import { SnmpLinkBadge } from "@/components/snmp-link-badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { hereUrl } from "@/lib/return-url"
import { VlanBadge } from "@/components/cells/vlan-badge"
import { DeviceCell } from "@/components/cells/device-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { vrfColumn } from "@/components/cells/vrf-cell"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

/** An interface row with its nesting depth (sub-interfaces indent under their
 * parent). Shared by the device interfaces table and the whole-stack table. */
export type NestedInterface = Interface & { _depth: number }

/**
 * Order interfaces so each child follows its parent, tracking nesting depth so
 * the name column can indent sub-interfaces under their parent.
 *
 * Lives here next to the columns that consume `_depth`, so every interface table
 * nests the same way - the whole-stack table used to flatten everything to depth
 * 0 and lost the hierarchy the per-device table showed.
 *
 * A parent outside `rows` (e.g. when nesting one stack member's interfaces at a
 * time) is treated as a root, so nothing is dropped.
 */
export function nestInterfaces(rows: Interface[]): NestedInterface[] {
  const ids = new Set(rows.map((r) => r.id))
  const childrenOf = new Map<string | null, Interface[]>()
  for (const r of rows) {
    const key = r.parent && ids.has(r.parent.id) ? r.parent.id : null
    const bucket = childrenOf.get(key) ?? []
    bucket.push(r)
    childrenOf.set(key, bucket)
  }
  const out: NestedInterface[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const r of childrenOf.get(parentId) ?? []) {
      out.push({ ...r, _depth: depth })
      walk(r.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export type InterfaceColumnId =
  | "device"
  | "name"
  | "type"
  | "lag"
  | "mac"
  | "layer"
  | "enabled"
  | "status"
  | "speed"
  | "mtu"
  | "vlan"
  | "vrf"
  | "ips"
  | "cables"
  | "tags"
  | "description"

const CANONICAL_ORDER: InterfaceColumnId[] = [
  "device",
  "name",
  "type",
  "lag",
  "mac",
  "layer",
  "enabled",
  "status",
  "speed",
  "mtu",
  "vlan",
  "vrf",
  "ips",
  "cables",
  "tags",
  "description",
]

/** The per-device / whole-stack interface table. No Device column (the whole
 * page is one device, or the Member column already names it), and no MTU / Tags
 * - those read on the interface detail page. Named so the per-device table and
 * the virtual-chassis table cannot drift apart. */
export const DEVICE_INTERFACE_COLUMNS: InterfaceColumnId[] = [
  "name",
  "type",
  "lag",
  "mac",
  "layer",
  "enabled",
  "status",
  "speed",
  "vlan",
  "vrf",
  "ips",
  "cables",
  "description",
]

export interface InterfaceColumnOpts<T extends Interface> {
  /** Drop columns. */
  omit?: InterfaceColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: InterfaceColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** SNMP drift items grouped by interface id - each drifted row gets a badge
   * whose popover lists exactly what differs (review/accept stays in the Drift
   * panel; source of truth is untouched). */
  driftByIface?: Map<string, SnmpDriftItem[]>
  /** Fleet-wide interface drift from `useInterfaceDriftMap()` - one request for
   * the whole table, for tables that span devices (/interfaces, the whole-stack
   * table) where a per-device drift query would be one request per row's device.
   * Ignored when `driftByIface` is given: that map comes from the device's own
   * drift query and its popover names the exact differences, so the page that
   * already has it must not also show the summarised marker. */
  drift?: Map<string, InterfaceDriftEntry>
  /** Open planned changes keyed by "api.interface:<id>". */
  planned?: Map<string, PlannedTargetRow>
  /** Cabled rows show an editable cable-status control instead of the plain
   * cable count. The per-device tables put that control in their actions
   * column, so they leave this off. */
  cableControl?: { canEdit: boolean }
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/**
 * The one source of truth for "a table of interfaces" - /interfaces, the
 * per-device "This member" table, the "Whole stack" (virtual chassis) table.
 * Sub-interfaces indent under their parent via `_depth` (see `nestInterfaces`);
 * flat rows simply render at depth 0. Callers pick columns with
 * `include`/`omit` and splice their own around this output (a Member column).
 */
export function buildInterfaceColumns<T extends Interface = NestedInterface>(
  opts: InterfaceColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const driftByIface = opts.driftByIface
  const omit = new Set(opts.omit ?? [])
  const keep = (id: InterfaceColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<InterfaceColumnId, () => ColumnDef<T, unknown>> = {
    device: () => ({
      id: "device",
      accessorFn: (r) => r.device.name,
      header: ({ column }) => <SortHeader column={column} label="Device" />,
      cell: ({ row }) => (
        <DeviceCell
          device={row.original.device}
          className="font-mono text-xs"
        />
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Device",
          get: (r: T) => r.device.id,
          formatValue: (_v, sample) => ({ label: sample.device.name }),
        },
      },
    }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Interface" />,
      cell: ({ row }) => {
        const depth =
          (row.original as Interface & { _depth?: number })._depth ?? 0
        return (
          <div
            className="flex items-center gap-1.5"
            style={{ paddingLeft: depth * 16 }}
          >
            {depth > 0 && (
              <span className="font-mono text-[11px] text-muted-foreground/50">
                └
              </span>
            )}
            <Link
              to="/interfaces/$id"
              params={{ id: row.original.id }}
              className="link font-mono font-medium"
            >
              {row.original.name}
            </Link>
            {row.original.label && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {row.original.label}
              </span>
            )}
            {row.original.virtual && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                virtual
              </Badge>
            )}
            {row.original.mgmt_only && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                mgmt
              </Badge>
            )}
            {row.original.combo_group && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[10px]"
                title={`Combo port - shares group "${row.original.combo_group}" with its alternate connector`}
              >
                combo
              </Badge>
            )}
            {row.original.snmp_name && <SnmpLinkBadge iface={row.original} />}
            {row.original.snmp_ignore && (
              // Config that changes what drift reports must be visible where
              // the port is listed, or its absence reads as a bug.
              <EyeOff
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label="Excluded from SNMP drift"
              >
                <title>Excluded from SNMP drift</title>
              </EyeOff>
            )}
            {driftByIface ? (
              <DriftBadge items={driftByIface.get(row.original.id) ?? []} />
            ) : (
              opts.drift && (
                // Interfaces are what drift references most, and the fleet list
                // showed none of it. Quiet marker, same glyph as the device one.
                <InterfaceDriftMarker
                  interfaceId={row.original.id}
                  map={opts.drift}
                />
              )
            )}
            {opts.planned && (
              <PlannedChangeMarker
                objectType="api.interface"
                objectId={row.original.id}
                map={opts.planned}
              />
            )}
            {row.original.tunnel_terminations.map((tt) => (
              <Link
                key={tt.id}
                to="/tunnels/$id"
                params={{ id: tt.tunnel.id }}
                title={`${tt.role_display} termination on tunnel ${tt.tunnel.name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <Badge
                  variant="secondary"
                  className="h-4 gap-1 px-1.5 text-[10px] hover:bg-muted"
                >
                  <Workflow className="h-2.5 w-2.5" />
                  {tt.tunnel.name}
                </Badge>
              </Link>
            ))}
          </div>
        )
      },
    }),
    lag: () => ({
      id: "lag",
      header: "LAG",
      // Bundle membership reads both ways: a member names its aggregate (and
      // the stack member holding it, when that's elsewhere); the aggregate
      // itself shows how many links it bundles.
      cell: ({ row }) => {
        const r = row.original
        if (r.lag) {
          const elsewhere = r.lag.device.id !== r.device.id
          return (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <Link
                to="/interfaces/$id"
                params={{ id: r.lag.id }}
                onClick={(e) => e.stopPropagation()}
              >
                <Badge
                  variant="secondary"
                  className="h-4 gap-1 px-1.5 font-mono text-[10px] hover:bg-muted"
                >
                  <Layers className="h-2.5 w-2.5" />
                  {r.lag.name}
                </Badge>
              </Link>
              {elsewhere && (
                <span className="text-[11px] text-muted-foreground">
                  on {r.lag.device.name}
                </span>
              )}
            </span>
          )
        }
        if (r.lag_member_count > 0)
          return (
            <Badge variant="secondary" className="h-4 gap-1 px-1.5 text-[10px]">
              <Layers className="h-2.5 w-2.5" />
              {r.lag_member_count} {r.lag_member_count === 1 ? "link" : "links"}
            </Badge>
          )
        return <span className="text-muted-foreground">-</span>
      },
    }),
    type: () => ({
      id: "type",
      header: "Type",
      cell: ({ row }) =>
        row.original.type ? (
          <span className="text-xs">{row.original.type_display}</span>
        ) : (
          dash
        ),
    }),
    mac: () => ({
      id: "mac",
      header: "MAC",
      cell: ({ row }) =>
        row.original.mac_address ? (
          <Link
            to="/macs/$mac"
            params={{ mac: row.original.mac_address }}
            className="link font-mono text-xs"
          >
            {row.original.mac_address}
          </Link>
        ) : (
          dash
        ),
    }),
    layer: () => ({
      id: "layer",
      header: "Layer",
      // Derived: an interface with an IP operates at L3, otherwise it's L2.
      cell: ({ row }) => (
        <Badge variant="secondary">
          {row.original.ip_addresses.length > 0 ? "L3" : "L2"}
        </Badge>
      ),
    }),
    enabled: () => ({
      id: "enabled",
      accessorKey: "enabled",
      header: "Enabled",
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="secondary">Disabled</Badge>
        ),
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      // Null is Active - the common case renders blank so the column only
      // draws the eye when a port is Planned / Not present / Decommissioning.
      cell: ({ row }) =>
        row.original.status ? (
          <StatusBadge status={row.original.status} />
        ) : null,
    }),
    speed: () => ({
      id: "speed",
      accessorKey: "speed",
      header: "Speed",
      cell: ({ row }) =>
        row.original.speed ? (
          <span className="text-xs">{row.original.speed}</span>
        ) : (
          dash
        ),
    }),
    mtu: () => ({
      id: "mtu",
      accessorKey: "mtu",
      header: "MTU",
      cell: ({ row }) =>
        row.original.mtu != null ? (
          <span className="num text-xs">{row.original.mtu}</span>
        ) : (
          dash
        ),
    }),
    vlan: () => ({
      id: "vlan",
      accessorFn: (r) => r.vlan?.vlan_id ?? "",
      header: ({ column }) => <SortHeader column={column} label="VLAN" />,
      cell: ({ row }) => {
        const r = row.original
        const tagged = r.tagged_vlans?.length ?? 0
        return r.vlan || tagged ? (
          <span className="flex items-center gap-1.5 font-mono text-xs">
            {r.vlan ? <VlanBadge vlan={r.vlan} /> : "-"}
            {r.mode === "tagged" && tagged > 0 && (
              // Hover reveals the truncated trunk members as VLAN badges.
              <HoverCard openDelay={100} closeDelay={80}>
                <HoverCardTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="h-4 cursor-default px-1 text-[10px]"
                  >
                    trunk +{tagged}
                  </Badge>
                </HoverCardTrigger>
                <HoverCardContent className="w-72">
                  <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                    Tagged VLANs on this trunk
                  </p>
                  <span className="flex flex-wrap gap-1">
                    {r.tagged_vlans.map((v) => (
                      <VlanBadge key={v.id} vlan={v} />
                    ))}
                  </span>
                </HoverCardContent>
              </HoverCard>
            )}
            {r.mode === "tagged-all" && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                trunk all
              </Badge>
            )}
          </span>
        ) : (
          dash
        )
      },
    }),
    vrf: () => vrfColumn<T>({ get: (r) => r.vrf }),
    ips: () => ({
      id: "ips",
      header: "IP addresses",
      cell: ({ row }) => {
        const ips = row.original.ip_addresses
        if (ips.length === 0) return dash
        return (
          <div className="flex flex-wrap gap-1">
            {ips.map((ip) => (
              <Link
                key={ip.id}
                to="/ips/$id"
                params={{ id: ip.id }}
                className="link font-mono text-xs"
              >
                {ip.ip_address}
              </Link>
            ))}
          </div>
        )
      },
    }),
    cables: () => ({
      id: "cables",
      accessorKey: "cable_count",
      header: opts.cableControl ? "Cable" : "Cables",
      cell: ({ row }) => {
        const cable = row.original.cable
        if (opts.cableControl && cable)
          return (
            <CableStatusControl
              cableId={cable.id}
              status={cable.status}
              canEdit={opts.cableControl.canEdit}
            />
          )
        // Uncabled ports still carry state worth seeing: an undocumented
        // cable (mark_connected) or a direct reservation.
        if (!cable && row.original.mark_connected) return <UndocumentedBadge />
        const resv = row.original.reservation
        if (!cable && resv) return <ReservedBadge reservation={resv} />
        return (
          <span className="num text-xs text-muted-foreground">
            {row.original.cable_count || "-"}
          </span>
        )
      },
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) =>
        row.original.description ? (
          <span className="text-xs">{row.original.description}</span>
        ) : (
          dash
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}

export interface InterfaceActionsOpts<T extends Interface> {
  /** The device that owns this row. Constant on a per-device table; per-row on
   * the whole-stack table (each row belongs to a different stack member). */
  deviceIdFor: (row: T) => string
  canAddIp: boolean
  canAssignIp: boolean
  canEdit: boolean
  canChangeCable: boolean
  canDeleteCable: boolean
  canConnect: boolean
  canReserve: boolean
  onTrace: (target: { id: string; name: string }) => void
  onAssignIp: (target: {
    deviceId: string
    interfaceId: string
    interfaceName: string
  }) => void
}

/**
 * The canonical interface row-actions column - cable status, trace / connect,
 * add + assign IP, edit. Shared so the per-device "This member" table and the
 * "Whole stack" table offer the same actions (the stack table resolves the
 * owning device per row via `deviceIdFor`).
 *
 * Returns `null` when the user can do none of add-IP / assign-IP / edit, so the
 * caller can omit the column entirely.
 */


/** Disconnect (delete) the cable on a cabled row (#137) - fetches the full
 * cable when clicked so the shared delete dialog can name both ends. */
function CableDisconnectAction({
  cableId,
  ifaceName,
}: {
  cableId: string
  ifaceName: string
}) {
  const [open, setOpen] = useState(false)
  const cableQ = useQuery({
    queryKey: ["cable", cableId],
    queryFn: () => api<Cable>(`/api/cables/${cableId}/`),
    enabled: open,
    staleTime: 10_000,
  })
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-muted-foreground hover:text-destructive"
        title="Disconnect cable"
        aria-label={`Disconnect ${ifaceName}`}
        onClick={() => setOpen(true)}
      >
        <Unplug className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <CableDeleteDialog
          cable={cableQ.data ?? null}
          onOpenChange={(o) => {
            if (!o) setOpen(false)
          }}
        />
      )}
    </>
  )
}

export function buildInterfaceActionsColumn<T extends Interface>(
  opts: InterfaceActionsOpts<T>
): ColumnDef<T> | null {
  const {
    deviceIdFor,
    canAddIp,
    canAssignIp,
    canEdit,
    canChangeCable,
    canDeleteCable,
    canConnect,
    canReserve,
    onTrace,
    onAssignIp,
  } = opts
  if (!canAddIp && !canAssignIp && !canEdit) return null
  return {
    id: "actions",
    enableHiding: false,
    cell: ({ row }) => {
      const iface = row.original
      const deviceId = deviceIdFor(iface)
      return (
        <div className="flex justify-end gap-1">
          {iface.cable && (
            <CableStatusControl
              cableId={iface.cable.id}
              status={iface.cable.status}
              canEdit={canChangeCable}
            />
          )}
          {iface.cable ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                title="Trace this run"
                aria-label={`Trace ${iface.name}`}
                onClick={() => onTrace({ id: iface.id, name: iface.name })}
              >
                <Waypoints className="h-3.5 w-3.5" />
              </Button>
              {canDeleteCable && (
                <CableDisconnectAction
                  cableId={iface.cable.id}
                  ifaceName={iface.name}
                />
              )}
            </>
          ) : (
            !iface.virtual && (
              <>
                {canConnect && (
                  <Button
                    size="sm"
                    variant="ghost"
                    asChild
                    className="h-7 text-muted-foreground hover:text-primary"
                    title="Connect cable"
                  >
                    <Link
                      to="/cables/new"
                      search={{
                        a_kind: "interface",
                        a_id: iface.id,
                        ret: hereUrl(),
                      }}
                    >
                      <CableIcon className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
                {!iface.mark_connected && (
                  <PortReserveAction
                    kind="interface"
                    portId={iface.id}
                    name={iface.name}
                    reservation={iface.reservation}
                    canReserve={canReserve}
                  />
                )}
                {/* Always available on an uncabled port: if a row ever
                    carries both the mark and a hold, this is how you get
                    out of it. */}
                {
                  <MarkConnectedToggle
                    endpoint="/api/interfaces/"
                    portId={iface.id}
                    name={iface.name}
                    marked={iface.mark_connected}
                    canEdit={canEdit}
                  />
                }
              </>
            )
          )}
          {canAddIp && (
            <Button size="sm" variant="ghost" asChild className="h-7">
              <Link
                to="/ips/new"
                search={{ device: deviceId, interface: iface.id }}
              >
                + Add IP
              </Link>
            </Button>
          )}
          {canAssignIp && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() =>
                onAssignIp({
                  deviceId,
                  interfaceId: iface.id,
                  interfaceName: iface.name,
                })
              }
            >
              Assign IP
            </Button>
          )}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              asChild
              className="h-7"
              aria-label={`Edit ${iface.name}`}
            >
              <Link
                to="/interfaces/$id/edit"
                params={{ id: iface.id }}
                search={{ ret: hereUrl() }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      )
    },
  }
}
