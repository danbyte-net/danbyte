import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type WirelessLANGroup, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { numidColumn } from "@/components/cells/numid"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { WlanGroupDeleteDialog } from "@/components/wlan-group-delete-dialog"

export const Route = createFileRoute("/wireless-lan-groups/")({
  component: WlanGroupsPage,
})

function WlanGroupsPage() {
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<WirelessLANGroup | null>(null)

  const query = useQuery({
    queryKey: ["wireless-lan-groups"],
    queryFn: () =>
      api<Paginated<WirelessLANGroup>>("/api/wireless-lan-groups/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return allRows
    return allRows.filter(
      (g) =>
        g.name.toLowerCase().includes(n) ||
        g.description.toLowerCase().includes(n)
    )
  }, [allRows, q])

  const onDelete = useCallback((g: WirelessLANGroup) => setDeleting(g), [])
  const columns = useMemo<ColumnDef<WirelessLANGroup>[]>(
    () => [
      ...(humanIds
        ? [numidColumn<WirelessLANGroup>({ get: (r) => r.numid })]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/wireless-lan-groups/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      {
        id: "wlans",
        accessorKey: "wlan_count",
        header: ({ column }) => <SortHeader column={column} label="WLANs" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.wlan_count}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "WLANs",
            get: (r: WirelessLANGroup) => (r.wlan_count > 0 ? "in" : "out"),
            formatValue: (v) => ({
              label: v === "in" ? "In use" : "Unused",
            }),
          },
        },
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/wireless-lan-groups/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [onDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Wireless LAN groups"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter groups…" }}
      actions={
        <>
          <TableActions ioType="wirelesslangroup" />
          <Button size="sm" asChild>
            <Link to="/wireless-lan-groups/new">Add group</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="wireless-lan-groups"
      />
      <WlanGroupDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
