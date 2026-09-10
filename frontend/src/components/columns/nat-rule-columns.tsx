import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"

import type { NATRule } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of NAT rules" - /nat-rules and the
// panes on a device and an IP address all build their columns here, so a rule
// reads identically wherever it appears.

/** "203.0.113.10:443" - the address and its port, or just one of them. */
export function natEndpoint(
  ip: { ip_address: string } | null,
  ports: string
): string {
  const addr = ip?.ip_address ?? ""
  if (addr && ports) return `${addr}:${ports}`
  return addr || (ports ? `:${ports}` : "")
}

export type NATRuleColumnId =
  | "numid"
  | "name"
  | "kind"
  | "outside"
  | "inside"
  | "device"
  | "source"
  | "status"
  | "description"
  | "updated"

const CANONICAL_ORDER: NATRuleColumnId[] = [
  "numid",
  "name",
  "kind",
  "outside",
  "inside",
  "device",
  "source",
  "status",
  "description",
  "updated",
]

export interface NATRuleColumnOpts<T extends NATRule = NATRule> {
  omit?: NATRuleColumnId[]
  include?: NATRuleColumnId[]
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Link names and addresses to their pages. Default true. */
  linked?: boolean
  actions?: ActionsColumnOpts<T>
}

/** One end of the translation: the address (linked) and its port. */
function Endpoint({
  ip,
  ports,
  linked,
}: {
  ip: NATRule["external_ip"]
  ports: string
  linked: boolean
}) {
  if (!ip && !ports) return dash
  return (
    <span className="font-mono text-xs whitespace-nowrap">
      {ip &&
        (linked ? (
          <Link to="/ips/$id" params={{ id: ip.id }} className="link">
            {ip.ip_address}
          </Link>
        ) : (
          ip.ip_address
        ))}
      {ports && (
        <span className={ip ? "text-muted-foreground" : undefined}>
          {ip ? ":" : ""}
          {ports}
        </span>
      )}
    </span>
  )
}

export function buildNATRuleColumns<T extends NATRule = NATRule>(
  opts: NATRuleColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: NATRuleColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))
  const linked = opts.linked ?? true

  const byId: Record<NATRuleColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) =>
        linked ? (
          <Link
            to="/nat-rules/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
        ) : (
          <span className="font-medium">{row.original.name}</span>
        ),
    }),
    kind: () => ({
      id: "kind",
      header: "Type",
      cell: ({ row }) => (
        <span className="text-xs whitespace-nowrap">
          {row.original.kind.toUpperCase()}
          <span className="ml-1.5 text-muted-foreground">
            {row.original.protocol_display}
          </span>
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.kind_display,
        },
      },
    }),
    // Outside → inside reads left to right, the way traffic travels.
    outside: () => ({
      id: "outside",
      header: "Outside",
      cell: ({ row }) => (
        <Endpoint
          ip={row.original.external_ip}
          ports={row.original.external_ports}
          linked={linked}
        />
      ),
    }),
    inside: () => ({
      id: "inside",
      header: "Inside",
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
          <Endpoint
            ip={row.original.internal_ip}
            ports={row.original.internal_ports}
            linked={linked}
          />
        </span>
      ),
    }),
    device: () => ({
      id: "device",
      header: ({ column }) => <SortHeader column={column} label="Firewall" />,
      accessorFn: (r) => r.device?.name ?? "",
      cell: ({ row }) => {
        const d = row.original.device
        if (!d) return dash
        return linked ? (
          <Link to="/devices/$id" params={{ id: d.id }} className="link text-xs">
            {d.name}
          </Link>
        ) : (
          <span className="text-xs">{d.name}</span>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Firewall",
          get: (r: T) => r.device?.name ?? "",
        },
      },
    }),
    source: () => ({
      id: "source",
      header: "From",
      cell: ({ row }) => {
        const r = row.original
        const from = r.source_ip?.ip_address ?? r.source_prefix?.cidr ?? ""
        return from ? (
          <span className="font-mono text-xs">{from}</span>
        ) : (
          <span className="text-xs text-muted-foreground">Any</span>
        )
      },
    }),
    status: () => ({
      id: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.name ?? "",
        },
      },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
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
