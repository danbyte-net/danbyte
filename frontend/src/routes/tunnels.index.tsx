import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Tunnel, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { buildTunnelColumns } from "@/components/columns/tunnel-columns"
import { TunnelDeleteDialog } from "@/components/tunnel-delete-dialog"
import { TunnelBulkBar } from "@/components/tunnel-bulk-bar"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/tunnels/")({ component: TunnelsPage })

function TunnelsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("tunnel", "add")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Tunnel | null>(null)
  const [selectedRows, setSelectedRows] = useState<Tunnel[]>([])
  const { humanIds } = useMe()

  const query = useQuery({
    queryKey: ["tunnels", q],
    queryFn: () =>
      api<Paginated<Tunnel>>(
        `/api/tunnels/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((t: Tunnel) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<Tunnel>[]>(
    () =>
      buildTunnelColumns({
        selection: true,
        humanIds,
        omit: ["description"],
        actions: {
          editTo: "/tunnels/$id/edit",
          editParams: (t) => ({ id: t.id }),
          onDelete,
        },
      }),
    [onDelete, humanIds]
  )

  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Tunnels"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter tunnels…" }}
      actions={
        <>
          <TableActions ioType="tunnel" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/tunnels/new">Add tunnel</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        onSelectedRowsChange={setSelectedRows}
        flexColumn="name"
        tableId="tunnels"
      />
      <TunnelDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <TunnelBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}
