import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type WirelessLAN, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { buildWirelessLANColumns } from "@/components/columns/wireless-lan-columns"
import { WirelessLANDeleteDialog } from "@/components/wireless-lan-delete-dialog"

export const Route = createFileRoute("/wireless-lans/")({
  component: WirelessLANsPage,
})

function WirelessLANsPage() {
  const { humanIds } = useMe()
  const { canDo } = useMe()
  const canAdd = canDo("wirelesslan", "add")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<WirelessLAN | null>(null)

  const query = useQuery({
    queryKey: ["wireless-lans", q],
    queryFn: () =>
      api<Paginated<WirelessLAN>>(
        `/api/wireless-lans/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((w: WirelessLAN) => setDeleting(w), [])
  const columns = useMemo<ColumnDef<WirelessLAN>[]>(
    () =>
      buildWirelessLANColumns({
        humanIds,
        omit: ["description"],
        actions: {
          editTo: "/wireless-lans/$id/edit",
          editParams: (w) => ({ id: w.id }),
          onDelete,
        },
      }),
    [onDelete, humanIds]
  )

  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Wireless LANs"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter by SSID…" }}
      actions={
        <>
          <TableActions ioType="wirelesslan" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/wireless-lans/new">Add wireless LAN</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="ssid"
        tableId="wireless-lans"
      />
      <WirelessLANDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
