import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type L2VPN, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildL2VPNColumns } from "@/components/columns/l2vpn-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { L2vpnDeleteDialog } from "@/components/l2vpn-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/l2vpns/")({ component: L2vpnsPage })

function L2vpnsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<L2VPN | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("l2vpn", "add")
  const canEdit = canDo("l2vpn", "change")
  const canDelete = canDo("l2vpn", "delete")

  const query = useQuery({
    queryKey: ["l2vpns", q],
    queryFn: () =>
      api<Paginated<L2VPN>>(
        `/api/l2vpns/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((v: L2VPN) => setDeleting(v), [])
  const columns = useMemo<ColumnDef<L2VPN>[]>(
    () =>
      buildL2VPNColumns({
        humanIds,
        actions: {
          editTo: canEdit ? "/l2vpns/$id/edit" : undefined,
          editParams: (r) => ({ id: r.id }),
          onDelete: canDelete ? onDelete : undefined,
        },
      }),
    [onDelete, humanIds, canEdit, canDelete]
  )

  const { rail, filteredRows, snapshot, restore, activeCount, columns: facetColumns } =
    useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="L2VPNs"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "l2vpn",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter L2VPNs…" }}
      actions={
        <>
          <TableActions ioType="l2vpn" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/l2vpns/new">Add L2VPN</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={facetColumns}
        flexColumn="description"
        tableId="l2vpns"
      />
      <L2vpnDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
