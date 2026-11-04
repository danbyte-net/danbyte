import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type DnsZone, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { buildDnsZoneColumns } from "@/components/columns/dns-zone-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { DnsZoneDialog } from "@/components/integrations/dns-zone-dialog"
import { useFacetRail } from "@/lib/use-facet-rail"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/dns-zones/")({
  component: DnsZonesPage,
})

function DnsZonesPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [q, setQ] = useUrlSearch()
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<DnsZone[]>([])
  const canManage = canDo("dnszone", "add")
  const canEdit = canDo("dnszone", "change")
  const canDelete = canDo("dnszone", "delete")
  const selectable = canEdit || canDelete
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

  // The zone name is the Open link; a zone's settings (reconcile, auto-add)
  // live on its detail page, so there is no row Edit. Delete only applies to
  // Danbyte-authored zones - a synced zone would just return on the next
  // sync. With no managed zones every cell would be empty, so the column
  // itself is dropped rather than left as a sliver.
  const hasManaged = rows.some((z) => z.managed)
  const columns = useMemo(
    () =>
      buildDnsZoneColumns<DnsZone>({
        selection: selectable,
        actions:
          canDelete && hasManaged
            ? {
                onDelete: (z) => del.mutate(z),
                canDelete: (z) => z.managed,
                deleteLabel: "Delete zone",
              }
            : undefined,
      }),
    [selectable, canDelete, hasManaged, del]
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
        <>
          <TableActions ioType="dnszone" />
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> Add zone
            </Button>
          )}
        </>
      }
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No DNS zones yet.">
          Connect a Windows DNS server under Integrations → Windows servers to
          sync its zones, or use <strong>Add zone</strong> to author one. Turn
          on reconcile for a synced zone to store its records.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dns-zones-all"
          flexColumn="name"
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/dns-zones/"
        noun={["zone", "zones"]}
        invalidate={[["dns-zones"], ["dns-records"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="dnszone"
      />
      {creating && <DnsZoneDialog onOpenChange={setCreating} />}
    </ListPageShell>
  )
}
