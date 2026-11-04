import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { MaintenanceEvent, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { useUrlTableFilters } from "@/components/table-filters"
import { buildMaintenanceColumns } from "@/components/columns/maintenance-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/maintenance/")({
  component: MaintenancePage,
})

// Provider maintenance windows and outages (issue #20). Statuses are rows
// from the tenant's /statuses catalog; the kind additionally carries its own
// colour (amber wrench / red zap), matching the calendar's treatment.

function MaintenancePage() {
  const [q, setQ] = useUrlSearch()
  const { canDo } = useMe()
  const { formatDateTime } = useDateFormat()
  const canAdd = canDo("maintenanceevent", "add")
  const canEdit = canDo("maintenanceevent", "change")
  const canDelete = canDo("maintenanceevent", "delete")
  const selectable = canEdit || canDelete
  const [selected, setSelected] = useState<MaintenanceEvent[]>([])

  const query = useQuery({
    queryKey: ["maintenance-events"],
    queryFn: () =>
      api<Paginated<MaintenanceEvent>>(
        "/api/monitoring/maintenance-events/?page_size=500"
      ),
  })
  const allRows = useMemo(() => {
    const rows = query.data?.results ?? []
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        (e.provider_name ?? "").toLowerCase().includes(needle) ||
        e.external_ref.toLowerCase().includes(needle)
    )
  }, [query.data, q])

  const columns = useMemo(
    () =>
      buildMaintenanceColumns({
        selection: selectable,
        formatDateTime,
        actions: {
          editTo: "/maintenance/$id/edit",
          editParams: (e) => ({ id: e.id }),
          canEdit: () => canEdit,
        },
      }),
    [canEdit, selectable, formatDateTime]
  )

  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Maintenance"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "maintenanceevent",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, provider, reference…",
      }}
      actions={
        canAdd && (
          <Button size="sm" asChild>
            <Link to="/maintenance/new">
              <Plus className="h-3.5 w-3.5" /> Add event
            </Link>
          </Button>
        )
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        tableId="maintenance-events"
        flexColumn="name"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/monitoring/maintenance-events/"
        noun={["event", "events"]}
        invalidate={[["maintenance-events"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="maintenanceevent"
      />
    </ListPageShell>
  )
}
