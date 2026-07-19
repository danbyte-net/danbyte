import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { Cable as CableIcon, Pencil, Waypoints } from "lucide-react"

import type { Interface } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CableStatusControl } from "@/components/cable-status-control"
import { SortHeader } from "@/components/data-table"

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

/**
 * The canonical read-only interface columns — name, type, MAC, layer, enabled,
 * speed, VLAN, VRF, IPs, cables. Shared so the per-device "This member" table
 * and the "Whole stack" (virtual chassis) table render identically; each caller
 * prepends/appends its own columns (a Member column, or the row actions).
 */
export function buildInterfaceColumns(): ColumnDef<NestedInterface>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Interface" />,
      cell: ({ row }) => {
        const depth = row.original._depth
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
              className="font-mono font-medium hover:underline"
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
            {row.original.lag && (
              <span className="text-[11px] text-muted-foreground">
                · LAG {row.original.lag.name}
              </span>
            )}
          </div>
        )
      },
    },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) =>
        row.original.type ? (
          <span className="text-xs">{row.original.type_display}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "mac",
      header: "MAC",
      cell: ({ row }) =>
        row.original.mac_address ? (
          <Link
            to="/macs/$mac"
            params={{ mac: row.original.mac_address }}
            className="font-mono text-xs text-primary hover:underline"
          >
            {row.original.mac_address}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "layer",
      header: "Layer",
      // Derived: an interface with an IP operates at L3, otherwise it's L2.
      cell: ({ row }) => (
        <Badge variant="secondary">
          {row.original.ip_addresses.length > 0 ? "L3" : "L2"}
        </Badge>
      ),
    },
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="secondary">Disabled</Badge>
        ),
    },
    {
      id: "speed",
      header: "Speed",
      cell: ({ row }) =>
        row.original.speed ? (
          <span className="text-xs">{row.original.speed}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
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
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: "vrf",
      header: "VRF",
      cell: ({ row }) =>
        row.original.vrf ? (
          <Link
            to="/vrfs/$id"
            params={{ id: row.original.vrf.id }}
            className="text-xs text-primary hover:underline"
          >
            {row.original.vrf.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "ips",
      header: "IP addresses",
      cell: ({ row }) => {
        const ips = row.original.ip_addresses
        if (ips.length === 0)
          return <span className="text-muted-foreground">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {ips.map((ip) => (
              <Link
                key={ip.id}
                to="/ips/$id"
                params={{ id: ip.id }}
                className="font-mono text-xs text-primary hover:underline"
              >
                {ip.ip_address}
              </Link>
            ))}
          </div>
        )
      },
    },
    {
      id: "cables",
      accessorKey: "cable_count",
      header: "Cables",
      cell: ({ row }) => (
        <span className="num text-xs text-muted-foreground">
          {row.original.cable_count || "—"}
        </span>
      ),
    },
  ]
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
