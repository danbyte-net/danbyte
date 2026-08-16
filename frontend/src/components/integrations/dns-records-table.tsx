import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DnsRecord, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"

/** True when Windows DNS sync is enabled for the active tenant. Cached, so the
 * IPAM detail pages can cheaply decide whether to show a DNS tab/section. */
export function useDnsEnabled(): boolean {
  const q = useQuery({
    queryKey: ["integrations-enabled"],
    queryFn: () => api<Record<string, boolean>>("/api/integrations/enabled/"),
    staleTime: 5 * 60_000,
  })
  return !!q.data?.dns
}

const TYPE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  A: "default",
  AAAA: "default",
  PTR: "secondary",
}

/** Column factory for stored DNS records — reused by the zone page, the prefix
 * DNS tab, and the IP DNS section. `showZone` adds the zone column (off when a
 * table already scopes to one zone). */
export function dnsRecordColumns(showZone: boolean): ColumnDef<DnsRecord>[] {
  const cols: ColumnDef<DnsRecord>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.name}</span>
      ),
    },
    {
      id: "type",
      accessorKey: "record_type",
      header: "Type",
      cell: ({ row }) => (
        <Badge
          variant={TYPE_VARIANT[row.original.record_type] ?? "outline"}
          className="text-[10px]"
        >
          {row.original.record_type}
        </Badge>
      ),
    },
    {
      id: "data",
      accessorKey: "data",
      header: "Data",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.data}</span>
      ),
    },
    {
      id: "ip",
      header: "IP address",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.ip_address ? (
          <Link
            to="/ips/$id"
            params={{ id: row.original.ip_address }}
            className="font-mono text-xs hover:underline"
          >
            {row.original.ip}
          </Link>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.ip} <span className="not-italic">· not in IPAM</span>
          </span>
        ),
    },
  ]
  if (showZone)
    cols.push({
      id: "zone",
      accessorKey: "zone_name",
      header: "Zone",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.zone_name}
        </span>
      ),
    })
  return cols
}

/** A stored-DNS-records table driven by a query string (zone/prefix/ip/…). */
export function DnsRecordsTable({
  params,
  queryKey,
  showZone = true,
  empty = "No DNS records.",
  tableId = "dns-records",
}: {
  params: string
  queryKey: unknown[]
  showZone?: boolean
  empty?: string
  tableId?: string
}) {
  const query = useQuery({
    queryKey,
    queryFn: () =>
      api<Paginated<DnsRecord>>(`/api/dns-records/?${params}&page_size=500`),
  })
  const rows = query.data?.results ?? []
  const columns = useMemo(() => dnsRecordColumns(showZone), [showZone])

  if (query.isError) return <QueryError error={query.error} />
  if (query.data && rows.length === 0) return <EmptyState title={empty} />
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId={tableId}
      flexColumn="name"
    />
  )
}
