import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import {
  Cable as CableIcon,
  EyeOff,
  Pencil,
  Waypoints,
  Workflow,
} from "lucide-react"

import { DriftBadge } from "@/components/drift-detail"
import {
  InterfaceDriftMarker,
  type InterfaceDriftEntry,
} from "@/components/monitoring/device-drift-badge"
import {
  PlannedChangeMarker,
  type PlannedTargetRow,
} from "@/components/planning/planned-change-badge"

import type { Interface, SnmpDriftItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CableStatusControl } from "@/components/cable-status-control"
import { SnmpLinkBadge } from "@/components/snmp-link-badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { DeviceCell } from "@/components/cells/device-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { vrfColumn } from "@/components/cells/vrf-cell"
import {
  actionsColumn,
  type ActionsColumnOpts,
} from "@/components/columns/actions-column"

/** An interface row with its nesting depth (sub-interfaces indent under their
 * parent). Shared by the device interfaces table and the whole-stack table. */
export type NestedInterface = Interface & { _depth: number }

/**
 * Order interfaces so each child follows its parent, tracking nesting depth so
 * the name column can indent sub-interfaces under their parent.
 *
 * Lives here next to the columns that consume `_depth`, so every interface table
 * nests the same way — the whole-stack table used to flatten everything to depth
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
  | "mac"
  | "layer"
  | "enabled"
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
  "mac",
  "layer",
  "enabled",
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
 * — those read on the interface detail page. Named so the per-device table and
 * the virtual-chassis table cannot drift apart. */
export const DEVICE_INTERFACE_COLUMNS: InterfaceColumnId[] = [
  "name",
  "type",
  "mac",
  "layer",
  "enabled",
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
  /** SNMP drift items grouped by interface id — each drifted row gets a badge
   * whose popover lists exactly what differs (review/accept stays in the Drift
   * panel; source of truth is untouched). */
  driftByIface?: Map<string, SnmpDriftItem[]>
  /** Fleet-wide interface drift from `useInterfaceDriftMap()` — one request for
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
 * The one source of truth for "a table of interfaces" — /interfaces, the
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
                title={`Combo port — shares group "${row.original.combo_group}" with its alternate connector`}
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
            {row.original.lag && (
              <span className="text-[11px] text-muted-foreground">
                · LAG {row.original.lag.name}
              </span>
            )}
          </div>
        )
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
      header: "VLAN",
      cell: ({ row }) => {
        const r = row.original
        const tagged = r.tagged_vlans?.length ?? 0
        return r.vlan || tagged ? (
          <span className="flex items-center gap-1.5 font-mono text-xs">
            {r.vlan ? `${r.vlan.vlan_id} · ${r.vlan.name}` : "—"}
            {r.mode === "tagged" && tagged > 0 && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                trunk +{tagged}
              </Badge>
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
        return (
          <span className="num text-xs text-muted-foreground">
            {row.original.cable_count || "—"}
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
  canConnect: boolean
  onTrace: (target: { id: string; name: string }) => void
  onAssignIp: (target: {
    deviceId: string
    interfaceId: string
    interfaceName: string
  }) => void
}

/**
 * The canonical interface row-actions column — cable status, trace / connect,
 * add + assign IP, edit. Shared so the per-device "This member" table and the
 * "Whole stack" table offer the same actions (the stack table resolves the
 * owning device per row via `deviceIdFor`).
 *
 * Returns `null` when the user can do none of add-IP / assign-IP / edit, so the
 * caller can omit the column entirely.
 */
export function buildInterfaceActionsColumn<T extends Interface>(
  opts: InterfaceActionsOpts<T>
): ColumnDef<T> | null {
  const {
    deviceIdFor,
    canAddIp,
    canAssignIp,
    canEdit,
    canChangeCable,
    canConnect,
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
          ) : (
            canConnect &&
            !iface.virtual && (
              <Button
                size="sm"
                variant="ghost"
                asChild
                className="h-7 text-muted-foreground/60 hover:text-foreground"
                title="Not cabled — connect a cable"
              >
                <Link
                  to="/cables/new"
                  search={{ a_kind: "interface", a_id: iface.id }}
                >
                  <CableIcon className="h-3.5 w-3.5" />
                </Link>
              </Button>
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
              <Link to="/interfaces/$id/edit" params={{ id: iface.id }}>
                <Pencil className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      )
    },
  }
}
