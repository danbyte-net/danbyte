import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { CornerDownRight } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Region, type Paginated } from "@/lib/api"
import { nestByParent } from "@/lib/nest"
import { useMe } from "@/lib/use-me"
import { numidColumn } from "@/components/cells/numid"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { RegionDeleteDialog } from "@/components/region-delete-dialog"

export const Route = createFileRoute("/regions/")({ component: RegionsPage })

function RegionsPage() {
  const { humanIds } = useMe()
  const { canDo } = useMe()
  const canAdd = canDo("region", "add")
  const canEdit = canDo("region", "change")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Region | null>(null)
  const [sel, setSel] = useState<Region[]>([])

  const query = useQuery({
    queryKey: ["regions"],
    queryFn: () => api<Paginated<Region>>("/api/regions/"),
  })

  const allRows = query.data?.results ?? []
  // Filter first, then nest (issue #70): sub-regions group under their
  // parent, depth-first, and a filtered-out parent's children surface at
  // the root - the same tree treatment as the Locations and prefix lists.
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    const filtered = !n
      ? allRows
      : allRows.filter(
          (r) =>
            r.name.toLowerCase().includes(n) ||
            r.description.toLowerCase().includes(n)
        )
    return nestByParent(filtered)
  }, [allRows, q])

  const onDelete = useCallback((r: Region) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<Region>[]>(
    () => [
      ...(canEdit ? [selectionColumn<Region>()] : []),
      ...(humanIds ? [numidColumn<Region>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => {
          const depth =
            (row.original as Region & { _depth?: number })._depth ?? 0
          return (
            <div className="flex items-center gap-0.5">
              {Array.from({ length: depth }, (_, i) => (
                <CornerDownRight
                  key={i}
                  aria-hidden
                  className="h-3 w-3 shrink-0 text-muted-foreground/40"
                />
              ))}
              <Link
                to="/regions/$id"
                params={{ id: row.original.id }}
                className="link font-medium"
              >
                {row.original.name}
              </Link>
            </div>
          )
        },
      },
      {
        id: "parent",
        accessorFn: (r) => r.parent?.name ?? "",
        header: "Parent",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.parent?.name ?? "-"}</span>
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
            {row.original.description || "-"}
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
    [onDelete, humanIds, canEdit]
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
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/regions/new">Add region</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="regions"
        onSelectedRowsChange={setSel}
      />
      <ComponentBulkBar
        endpoint="/api/regions/"
        kindLabel="region"
        selected={sel}
        onCleared={() => setSel([])}
        invalidate={[["regions"]]}
        canDelete={false}
        fields={[
          {
            key: "parent_id",
            label: "Parent region",
            kind: "object",
            object_model: "region",
          },
        ]}
      />
      <RegionDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
