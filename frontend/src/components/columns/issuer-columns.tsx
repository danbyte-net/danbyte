import type { ColumnDef } from "@tanstack/react-table"

import type { DnsProvider, Issuer } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of certificate issuers" (ACME
// directories). /certificate-issuers builds here.

export type IssuerColumnId =
  "name" | "directory_url" | "account" | "dns" | "enabled" | "created"

const CANONICAL_ORDER: IssuerColumnId[] = [
  "name",
  "directory_url",
  "account",
  "dns",
  "enabled",
  "created",
]

export const DNS_PROVIDER_LABEL: Record<DnsProvider, string> = {
  "": "Manual",
  rfc2136: "RFC2136 / TSIG",
  "gss-tsig": "Windows AD (GSS-TSIG)",
}

export interface IssuerColumnOpts<T extends Issuer = Issuer> {
  omit?: IssuerColumnId[]
  include?: IssuerColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** The name opens the issuer (its edit dialog); plain text without. */
  onOpen?: (row: T) => void
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildIssuerColumns<T extends Issuer = Issuer>(
  opts: IssuerColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: IssuerColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<IssuerColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) =>
        opts.onOpen ? (
          <button
            type="button"
            className="link font-medium"
            onClick={() => opts.onOpen!(row.original)}
          >
            {row.original.name}
          </button>
        ) : (
          <span className="font-medium">{row.original.name}</span>
        ),
    }),
    directory_url: () => ({
      id: "directory_url",
      accessorFn: (r) => r.directory_url,
      header: "Directory",
      cell: ({ row }) => (
        <span className="font-mono text-[12px] text-muted-foreground">
          {row.original.directory_url}
        </span>
      ),
    }),
    account: () => ({
      id: "account",
      accessorFn: (r) => (r.account_registered ? "yes" : "no"),
      header: "Account",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.account_registered ? (
          <Badge variant="success">Registered</Badge>
        ) : (
          <Badge variant="outline">Not registered</Badge>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Account",
          get: (r: T) => (r.account_registered ? "yes" : "no"),
          formatValue: (v: string) => ({
            label: v === "yes" ? "Registered" : "Not registered",
          }),
        },
      },
    }),
    dns: () => ({
      id: "dns",
      accessorFn: (r) => DNS_PROVIDER_LABEL[r.dns_provider],
      header: "DNS-01",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {DNS_PROVIDER_LABEL[row.original.dns_provider]}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "DNS-01",
          get: (r: T) => DNS_PROVIDER_LABEL[r.dns_provider],
        },
      },
    }),
    enabled: () => ({
      id: "enabled",
      accessorFn: (r) => (r.enabled ? "on" : "off"),
      header: "Enabled",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge variant="secondary">On</Badge>
        ) : (
          <Badge variant="outline">Off</Badge>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Enabled",
          get: (r: T) => (r.enabled ? "on" : "off"),
          formatValue: (v: string) => ({ label: v === "on" ? "On" : "Off" }),
        },
      },
    }),
    created: () => ({
      id: "created",
      accessorFn: (r) => r.created_at,
      header: "Created",
      cell: ({ row }) => <TimeCell iso={row.original.created_at} />,
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
