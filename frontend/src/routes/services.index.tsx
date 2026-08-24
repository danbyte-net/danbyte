import { createFileRoute } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Service } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { buildServiceColumns } from "@/components/columns/service-columns"
import { ServiceDeleteDialog } from "@/components/service-delete-dialog"
import { ServiceFormDialog } from "@/components/services-pane"
import { ListPageShell } from "@/components/list-page-shell"
import { Button } from "@/components/ui/button"
import { useTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/services/")({ component: ServicesPage })

function ServicesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Service | null>(null)
  const { canDo, humanIds } = useMe()
  const canDelete = canDo("service", "delete")
  const canAdd = canDo("service", "add")
  const [adding, setAdding] = useState(false)

  const query = useQuery({
    queryKey: ["services-list", q],
    queryFn: () =>
      api<Paginated<Service>>(
        `/api/services/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((s: Service) => setDeleting(s), [])

  const columns = useMemo<ColumnDef<Service>[]>(
    () =>
      buildServiceColumns<Service>({
        selection: true,
        humanIds,
        omit: ["monitored"],
        actions: {
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Services"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "service",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="service" />
          {canAdd && (
            <Button size="sm" onClick={() => setAdding(true)}>
              Add service
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="services"
      />
      <ServiceDeleteDialog
        service={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <ServiceFormDialog
        service={null}
        open={adding}
        onOpenChange={(o) => !o && setAdding(false)}
        onSaved={() => query.refetch()}
      />
    </ListPageShell>
  )
}
