import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Region, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { numidColumn } from "@/components/cells/numid"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { RegionDeleteDialog } from "@/components/region-delete-dialog"

export const Route = createFileRoute("/regions/")({ component: RegionsPage })

function RegionsPage() {
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Region | null>(null)

  const query = useQuery({
    queryKey: ["regions"],
    queryFn: () => api<Paginated<Region>>("/api/regions/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return allRows
    return allRows.filter(
      (r) =>
        r.name.toLowerCase().includes(n) ||
        r.description.toLowerCase().includes(n)
    )
  }, [allRows, q])

  const onDelete = useCallback((r: Region) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<Region>[]>(
    () => [
      ...(humanIds ? [numidColumn<Region>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/regions/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "parent",
        accessorFn: (r) => r.parent?.name ?? "",
        header: "Parent",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.parent?.name ?? "—"}</span>
        ),
      },
      {
        id: "children",
        accessorKey: "child_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Sub-regions" />
        ),
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.child_count}</span>
        ),
      },
      {
        id: "sites",
        accessorKey: "site_count",
        header: ({ column }) => <SortHeader column={column} label="Sites" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.site_count}</span>
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
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/regions/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [onDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Regions"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter regions…",
      }}
      actions={
        <>
          <TableActions ioType="region" />
          <Button size="sm" asChild>
            <Link to="/regions/new">Add region</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="regions"
      />
      <RegionDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
