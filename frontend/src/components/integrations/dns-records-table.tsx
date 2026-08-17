import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { api, type DnsRecord, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
            className="link font-mono text-xs"
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
        <Link
          to="/dns-zones/$id"
          params={{ id: row.original.zone }}
          className="link font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          {row.original.zone_name}
        </Link>
      ),
    })
  return cols
}

/** A stored-DNS-records table. Either fetches from a query string
 * (zone/prefix/ip/…) or renders `rows` supplied by a faceted parent. */
export function DnsRecordsTable({
  params,
  queryKey,
  rows: providedRows,
  showZone = true,
  empty = "No DNS records.",
  tableId = "dns-records",
}: {
  params?: string
  queryKey?: unknown[]
  /** When set, these rows are rendered instead of fetching (parent facets). */
  rows?: DnsRecord[]
  showZone?: boolean
  empty?: string
  tableId?: string
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canImport = canDo("ipaddress", "add")
  const query = useQuery({
    queryKey: queryKey ?? ["dns-records", "unused"],
    queryFn: () =>
      api<Paginated<DnsRecord>>(`/api/dns-records/?${params}&page_size=500`),
    enabled: providedRows === undefined,
  })
  const rows = providedRows ?? query.data?.results ?? []

  const importOne = useMutation({
    mutationFn: (rec: DnsRecord) =>
      api<{ ok: boolean; error?: string }>(
        `/api/dns-records/${rec.id}/import/`,
        { method: "POST", body: "{}" }
      ),
    onSuccess: (r) => {
      if (r.ok) toast.success("Added to IPAM")
      else toast.error(r.error || "Could not import")
      qc.invalidateQueries({ queryKey: ["dns-records"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo(() => {
    const cols = dnsRecordColumns(showZone)
    if (canImport)
      cols.push({
        id: "import",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.ip_address ? null : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={importOne.isPending}
              onClick={() => importOne.mutate(row.original)}
            >
              Add to IPAM
            </Button>
          ),
      })
    return cols
  }, [showZone, canImport, importOne])

  if (query.isError) return <QueryError error={query.error} />
  if (rows.length === 0 && (providedRows !== undefined || query.data))
    return <EmptyState title={empty} />
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId={tableId}
      flexColumn="name"
    />
  )
}
