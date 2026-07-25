import { createFileRoute } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Service } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { buildServiceColumns } from "@/components/columns/service-columns"
import { ServiceDeleteDialog } from "@/components/service-delete-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/services/")({ component: ServicesPage })

function ServicesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Service | null>(null)
  const { canDo, humanIds } = useMe()
  const canDelete = canDo("service", "delete")

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
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Services"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={<TableActions ioType="service" />}
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
    </ListPageShell>
  )
}
