import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { ZabbixConnection, ZabbixScope } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Section } from "@/components/ui/section"

type ScopeRow = ZabbixScope["devices"][number]

/**
 * Which devices this connection should be keeping hosts for.
 *
 * Scope is derived - a `zabbix` check on one of this connection's engines *is*
 * the statement "I want Zabbix watching this" - and derived state that nothing
 * renders is state nobody can trust. Two devices left scope during a
 * reconciliation pass and no page would have shown it.
 */
export function ZabbixScopeList({
  connection,
}: {
  connection: ZabbixConnection
}) {
  const scope = useQuery({
    queryKey: ["zabbix-scope", connection.id],
    queryFn: () =>
      api<ZabbixScope>(`/api/zabbix/connections/${connection.id}/scope/`),
  })
  const rows = scope.data?.devices ?? []

  const columns = useMemo<ColumnDef<ScopeRow>[]>(
    () => [
      {
        id: "device",
        accessorFn: (r) => r.device.name,
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.device.id }}
            className="link font-medium"
          >
            {row.original.device.name}
          </Link>
        ),
      },
      {
        id: "address",
        accessorKey: "address",
        header: ({ column }) => <SortHeader column={column} label="Address" />,
        cell: ({ row }) =>
          row.original.address ? (
            <span className="font-mono text-xs">{row.original.address}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "site",
        accessorKey: "site",
        header: ({ column }) => <SortHeader column={column} label="Site" />,
        cell: ({ row }) =>
          row.original.site || <span className="text-muted-foreground">-</span>,
      },
      {
        id: "templates",
        header: "Templates",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.templates.length ? (
            <span className="flex flex-wrap gap-1">
              {row.original.templates.map((t) => (
                <Badge key={t} variant="secondary">
                  {t}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "groups",
        header: "Host groups",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            {row.original.groups.map((g) => (
              <Badge key={g} variant="outline">
                {g}
              </Badge>
            ))}
          </span>
        ),
      },
      {
        id: "proxy",
        accessorKey: "proxy",
        header: ({ column }) => <SortHeader column={column} label="Proxy" />,
        cell: ({ row }) =>
          row.original.proxy ? (
            <span className="font-mono text-xs">{row.original.proxy}</span>
          ) : (
            <span className="text-muted-foreground">server</span>
          ),
      },
      {
        id: "state",
        accessorFn: (r) => stateOf(r).label,
        header: ({ column }) => <SortHeader column={column} label="State" />,
        cell: ({ row }) => {
          const s = stateOf(row.original)
          return <Badge variant={s.variant}>{s.label}</Badge>
        },
        meta: {
          facet: {
            kind: "enum",
            label: "State",
            get: (r: ScopeRow) => stateOf(r).label,
            formatValue: (v: string) => ({ label: v }),
          },
        },
      },
    ],
    []
  )

  return (
    <Section title="In scope" count={rows.length}>
      {scope.isLoading ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing in scope">
          Add a Zabbix check to a device&apos;s address and it appears here.
        </EmptyState>
      ) : (
        <DataTable
          tableId="zabbix-scope"
          data={rows}
          columns={columns}
          flexColumn="templates"
        />
      )}
    </Section>
  )
}

/** Where this device has got to, as one pill. */
function stateOf(row: ScopeRow): {
  label: string
  variant: "success" | "warning" | "destructive"
} {
  if (row.pending.length > 0) return { label: "To review", variant: "warning" }
  if (row.hostid) return { label: "Linked", variant: "success" }
  return { label: "No host", variant: "destructive" }
}
