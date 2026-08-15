import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Service } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of services". Every surface that lists
// services — /services, the device / VM Services pane — builds its columns here
// so a service row reads identically everywhere. Page-specific columns (the
// pane's Monitor toggle + dialog editor) are spliced around this factory's
// output; the shared cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; panes that
// don't render a facet rail simply ignore it.

/** "TCP 443, 8443" — protocol uppercase + comma-joined ports. */
function formatProtocolPorts(svc: Service): string {
  return `${svc.protocol.toUpperCase()} ${svc.ports.join(", ")}`
}

export type ServiceColumnId =
  | "numid"
  | "name"
  | "ports"
  | "parent"
  | "ip"
  | "monitored"
  | "description"
  | "updated"

const CANONICAL_ORDER: ServiceColumnId[] = [
  "numid",
  "name",
  "ports",
  "parent",
  "ip",
  "monitored",
  "description",
  "updated",
]

export interface ServiceColumnOpts<T extends Service = Service> {
  /** Drop columns. */
  omit?: ServiceColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: ServiceColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Link the name and IP to their detail pages. Default true; the pane on a
   * device / VM renders them as plain text — the row's own edit dialog is the
   * way in from there. */
  linked?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildServiceColumns<T extends Service = Service>(
  opts: ServiceColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: ServiceColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))
  const linked = opts.linked ?? true

  const byId: Record<ServiceColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          {linked ? (
            <Link
              to="/services/$id"
              params={{ id: row.original.id }}
              className="font-medium hover:underline"
            >
              {row.original.name}
            </Link>
          ) : (
            <span className="font-medium">{row.original.name}</span>
          )}
          <PlannedChangeMarker
            objectType="api.service"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    ports: () => ({
      id: "ports",
      header: "Protocol / Ports",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {formatProtocolPorts(row.original)}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Protocol",
          get: (r: T) => r.protocol_display,
        },
      },
    }),
    parent: () => ({
      id: "parent",
      header: ({ column }) => <SortHeader column={column} label="Parent" />,
      accessorFn: (r) => r.device?.name ?? r.virtual_machine?.name ?? "",
      cell: ({ row }) => {
        const s = row.original
        if (s.device)
          return (
            <Link
              to="/devices/$id"
              params={{ id: s.device.id }}
              className="text-xs text-primary hover:underline"
            >
              {s.device.name}
            </Link>
          )
        if (s.virtual_machine)
          return (
            <Link
              to="/virtual-machines/$id"
              params={{ id: s.virtual_machine.id }}
              className="text-xs text-primary hover:underline"
            >
              {s.virtual_machine.name}
            </Link>
          )
        return dash
      },
    }),
    ip: () => ({
      id: "ip",
      header: "IP",
      cell: ({ row }) => {
        const ip = row.original.ip_address
        if (!ip) return dash
        return linked ? (
          <Link
            to="/ips/$id"
            params={{ id: ip.id }}
            className="font-mono text-xs text-primary hover:underline"
          >
            {ip.ip_address}
          </Link>
        ) : (
          <span className="font-mono text-xs">{ip.ip_address}</span>
        )
      },
    }),
    monitored: () => ({
      id: "monitored",
      header: "Monitoring",
      cell: ({ row }) => {
        const svc = row.original
        if (!svc.monitored)
          return <span className="text-muted-foreground">Off</span>
        return svc.check_count > 0 ? (
          <Badge variant="success" title={`${svc.check_count} port check(s)`}>
            Monitored
          </Badge>
        ) : (
          <Badge
            variant="warning"
            title="Monitored, but no target IP yet — set an IP on the service or a primary IP on its device/VM."
          >
            No IP
          </Badge>
        )
      },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
