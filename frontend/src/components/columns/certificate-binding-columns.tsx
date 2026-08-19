import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CertificateBinding } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/cells/dash"

// The one source of truth for "a table of certificate bindings" - the
// endpoints that served a certificate. Used by the Bindings tab on a
// certificate's detail page, the tab that answers "what breaks when this
// expires". Per-endpoint facts (chain depth, chain verified) live on the
// binding, not the certificate, so they render here.

export type CertBindingColumnId =
  | "endpoint"
  | "ip"
  | "port"
  | "sni"
  | "chain_depth"
  | "chain_verified"
  | "first_seen"
  | "last_seen"

const CANONICAL_ORDER: CertBindingColumnId[] = [
  "endpoint",
  "ip",
  "port",
  "sni",
  "chain_depth",
  "chain_verified",
  "first_seen",
  "last_seen",
]

export interface CertBindingColumnOpts {
  omit?: CertBindingColumnId[]
  include?: CertBindingColumnId[]
}

export function buildCertificateBindingColumns(
  opts: CertBindingColumnOpts = {}
): ColumnDef<CertificateBinding, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: CertBindingColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<
    CertBindingColumnId,
    () => ColumnDef<CertificateBinding, unknown>
  > = {
    endpoint: () => ({
      id: "endpoint",
      accessorFn: (b) => b.endpoint,
      header: ({ column }) => <SortHeader column={column} label="Endpoint" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.endpoint}</span>
      ),
    }),
    ip: () => ({
      id: "ip",
      accessorFn: (b) => b.target_ip_address ?? "",
      header: "IP address",
      cell: ({ row }) =>
        row.original.target_ip && row.original.target_ip_address ? (
          <Link
            to="/ips/$id"
            params={{ id: row.original.target_ip }}
            className="link font-mono text-xs"
          >
            {row.original.target_ip_address}
          </Link>
        ) : (
          dash
        ),
    }),
    port: () => ({
      id: "port",
      accessorFn: (b) => b.port,
      header: "Port",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.port}</span>
      ),
    }),
    sni: () => ({
      id: "sni",
      accessorFn: (b) => b.server_name,
      header: "SNI",
      cell: ({ row }) =>
        row.original.server_name ? (
          <span className="font-mono text-xs">{row.original.server_name}</span>
        ) : (
          dash
        ),
    }),
    chain_depth: () => ({
      id: "chain_depth",
      accessorFn: (b) => b.chain_depth,
      header: ({ column }) => <SortHeader column={column} label="Depth" />,
      // 0 is the end-entity (leaf); deeper positions are intermediates.
      cell: ({ row }) => (
        <span className="text-xs">
          {row.original.chain_depth === 0 ? (
            <Badge variant="secondary" className="text-xs">
              leaf
            </Badge>
          ) : (
            <span className="num text-muted-foreground">
              {row.original.chain_depth}
            </span>
          )}
        </span>
      ),
    }),
    chain_verified: () => ({
      id: "chain_verified",
      accessorFn: (b) =>
        b.chain_verified === null ? "" : b.chain_verified ? "yes" : "no",
      header: "Chain",
      // A false verify is meaningful (self-signed / incomplete chain from this
      // endpoint) - surfaced honestly, not hidden. null = not known.
      cell: ({ row }) => {
        const v = row.original.chain_verified
        if (v === null)
          return <span className="text-xs text-muted-foreground">Unknown</span>
        return v ? (
          <Badge variant="success" className="text-xs">
            Verified
          </Badge>
        ) : (
          <Badge variant="warning" className="text-xs">
            Unverified
          </Badge>
        )
      },
    }),
    first_seen: () => ({
      id: "first_seen",
      accessorFn: (b) => b.first_seen,
      header: "First seen",
      cell: ({ row }) => <TimeCell iso={row.original.first_seen} />,
    }),
    last_seen: () => ({
      id: "last_seen",
      accessorFn: (b) => b.last_seen,
      header: ({ column }) => <SortHeader column={column} label="Last seen" />,
      cell: ({ row }) => <TimeCell iso={row.original.last_seen} />,
    }),
  }

  const cols: ColumnDef<CertificateBinding, unknown>[] = []
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  return cols
}
