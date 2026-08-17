import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type DnsZone, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { DnsZoneDialog } from "@/components/integrations/dns-zone-dialog"
import { useFacetRail } from "@/lib/use-facet-rail"

export const Route = createFileRoute("/dns-zones/")({
  component: DnsZonesPage,
})

function DnsZonesPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const canManage = canDo("dnszone", "add")
  const canDelete = canDo("dnszone", "delete")
  const query = useQuery({
    queryKey: ["dns-zones", "all", q],
    queryFn: () =>
      api<Paginated<DnsZone>>(
        `/api/dns-zones/?${new URLSearchParams({ search: q })}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const del = useMutation({
    mutationFn: (z: DnsZone) =>
      api(`/api/dns-zones/${z.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Zone deleted")
      qc.invalidateQueries({ queryKey: ["dns-zones"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<DnsZone>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Zone" />,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <Link
              to="/dns-zones/$id"
              params={{ id: row.original.id }}
              className="link font-mono text-xs font-medium"
            >
              {row.original.name}
            </Link>
            {row.original.managed && (
              <Badge
                variant="outline"
                className="text-[9px] text-muted-foreground"
                title="Authored in Danbyte — not mirrored from a server"
              >
                managed
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "type",
        accessorKey: "zone_type",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.zone_type}
            {row.original.is_reverse ? " · reverse" : ""}
          </span>
        ),
      },
      {
        id: "server",
        accessorKey: "connection_name",
        header: "Server",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.connection_name}
          </span>
        ),
      },
      {
        id: "records",
        accessorKey: "record_count",
        header: ({ column }) => <SortHeader column={column} label="Records" />,
        cell: ({ row }) =>
          row.original.sync && row.original.record_count > 0 ? (
            <Link
              to="/dns-records"
              search={{ zone: row.original.id }}
              className="num link"
            >
              {row.original.record_count}
            </Link>
          ) : (
            <span className="num">
              {row.original.sync ? row.original.record_count : "—"}
            </span>
          ),
      },
      {
        id: "reconcile",
        header: "Reconcile",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.sync ? (
            <Badge variant="success" className="text-[10px]">
              on
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">off</span>
          ),
      },
      {
        id: "drift",
        header: "Drift",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.drift_count > 0 ? (
            <Badge variant="destructive" className="text-[10px]">
              {row.original.drift_count}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      ...(canDelete
        ? [
            {
              id: "actions",
              enableSorting: false,
              cell: ({ row }: { row: { original: DnsZone } }) =>
                // Only Danbyte-authored zones can be deleted; synced zones would
                // just return on the next sync.
                row.original.managed ? (
                  <RowActions
                    onDelete={() => del.mutate(row.original)}
                    deleteLabel="Delete zone"
                  />
                ) : null,
            } as ColumnDef<DnsZone>,
          ]
        : []),
    ],
    [canDelete, del]
  )

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "server",
      label: "Server",
      get: (r) => ({ value: r.connection_name, label: r.connection_name }),
    },
    {
      key: "direction",
      label: "Direction",
      get: (r) => ({
        value: r.is_reverse ? "reverse" : "forward",
        label: r.is_reverse ? "Reverse" : "Forward",
      }),
    },
    {
      key: "reconcile",
      label: "Reconcile",
      get: (r) => ({
        value: r.sync ? "on" : "off",
        label: r.sync ? "On" : "Off",
      }),
    },
  ])

  return (
    <ListPageShell
      title="DNS zones"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter zones…" }}
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Add zone
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No DNS zones yet.">
          Connect a Windows DNS server under Integrations → Windows servers to
          sync its zones, or use <strong>Add zone</strong> to author one. Turn on
          reconcile for a synced zone to store its records.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dns-zones-all"
          flexColumn="name"
        />
      )}
      {creating && <DnsZoneDialog onOpenChange={setCreating} />}
    </ListPageShell>
  )
}
