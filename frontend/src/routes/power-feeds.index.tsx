import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type PowerFeed, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildPowerFeedColumns } from "@/components/columns/power-feed-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { PowerFeedDeleteDialog } from "@/components/power-feed-delete-dialog"

export const Route = createFileRoute("/power-feeds/")({
  component: PowerFeedsPage,
})

function PowerFeedsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("powerfeed", "add")
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<PowerFeed | null>(null)

  const query = useQuery({
    queryKey: ["power-feeds", q],
    queryFn: () =>
      api<Paginated<PowerFeed>>(
        `/api/power-feeds/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((f: PowerFeed) => setDeleting(f), [])
  const columns = useMemo<ColumnDef<PowerFeed>[]>(
    () =>
      buildPowerFeedColumns<PowerFeed>({
        humanIds,
        omit: ["max"],
        actions: {
          editTo: "/power-feeds/$id/edit",
          editParams: (f) => ({ id: f.id }),
          onDelete,
        },
      }),
    [onDelete, humanIds]
  )

  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Power feeds"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "powerfeed",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter feeds…" }}
      actions={
        <>
          <TableActions ioType="powerfeed" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/power-feeds/new">Add feed</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="name"
        tableId="power-feeds"
      />
      <PowerFeedDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
