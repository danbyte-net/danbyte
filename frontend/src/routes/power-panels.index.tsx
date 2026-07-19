import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type PowerPanel, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { numidColumn } from "@/components/cells/numid"
import { SiteCell } from "@/components/cells/site-cell"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { PowerPanelDeleteDialog } from "@/components/power-panel-delete-dialog"

export const Route = createFileRoute("/power-panels/")({
  component: PowerPanelsPage,
})

function PowerPanelsPage() {
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<PowerPanel | null>(null)

  const query = useQuery({
    queryKey: ["power-panels", q],
    queryFn: () =>
      api<Paginated<PowerPanel>>(
        `/api/power-panels/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((p: PowerPanel) => setDeleting(p), [])
  const columns = useMemo<ColumnDef<PowerPanel>[]>(
    () => [
      ...(humanIds ? [numidColumn<PowerPanel>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/power-panels/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "site",
        accessorFn: (p) => p.site?.name ?? "",
        header: "Site",
        cell: ({ row }) => (
          <SiteCell site={row.original.site} className="text-xs" />
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Site",
            get: (r: PowerPanel) => r.site?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.site?.name ?? "No site",
            }),
          },
        },
      },
      {
        id: "feeds",
        accessorKey: "feed_count",
        header: ({ column }) => <SortHeader column={column} label="Feeds" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.feed_count}</span>
        ),
      },
      {
        id: "comments",
        accessorKey: "comments",
        header: "Comments",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.comments || "—"}
          </span>
        ),
      },
      tagsColumn<PowerPanel>({ getTags: (r) => r.tags }),
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/power-panels/$id/edit"
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
      title="Power panels"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter panels…" }}
      actions={
        <>
          <TableActions ioType="powerpanel" />
          <Button size="sm" asChild>
            <Link to="/power-panels/new">Add panel</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="comments"
        tableId="power-panels"
      />
      <PowerPanelDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
