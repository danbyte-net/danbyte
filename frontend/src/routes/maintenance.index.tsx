import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus, Wrench, Zap } from "lucide-react"
import { useMemo, useState } from "react"

import { api, type MaintenanceEvent, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { actionsColumn } from "@/components/columns/actions-column"
import { StatusBadge } from "@/components/status-badge"
import { TimeCell } from "@/components/cells/time-ago"

export const Route = createFileRoute("/maintenance/")({
  component: MaintenancePage,
})

// Provider maintenance windows and outages (issue #20). Statuses are rows
// from the tenant's /statuses catalog; the kind additionally carries its own
// colour (amber wrench / red zap), matching the calendar's treatment.

function KindCell({ event }: { event: MaintenanceEvent }) {
  return event.kind === "outage" ? (
    <span className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400">
      <Zap className="h-3.5 w-3.5" /> Outage
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
      <Wrench className="h-3.5 w-3.5" /> Maintenance
    </span>
  )
}

function MaintenancePage() {
  const [q, setQ] = useState("")
  const { canDo } = useMe()
  const { formatDateTime } = useDateFormat()
  const canAdd = canDo("maintenanceevent", "add")
  const canEdit = canDo("maintenanceevent", "change")

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

  const columns = useMemo<ColumnDef<MaintenanceEvent>[]>(
    () => [
      {
        id: "kind",
        header: "Kind",
        accessorKey: "kind",
        meta: {
          facet: {
            kind: "enum",
            label: "Kind",
            get: (e) => e.kind,
            formatValue: (v) => ({
              label: v === "outage" ? "Outage" : "Maintenance",
            }),
          },
        },
        cell: ({ row }) => <KindCell event={row.original} />,
      },
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => (
          <Link
            to="/maintenance/$id/edit"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "provider",
        header: "Provider",
        meta: {
          facet: {
            kind: "enum",
            label: "Provider",
            get: (e) => e.provider_name || "__none__",
            formatValue: (v) => ({
              label: v === "__none__" ? "Internal" : v,
            }),
          },
        },
        cell: ({ row }) =>
          row.original.provider_name || (
            <span className="text-muted-foreground">Internal</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (e) => e.status.name,
          },
        },
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "window",
        header: "Window",
        cell: ({ row }) => {
          const e = row.original
          return (
            <span className="num text-[12px] whitespace-nowrap">
              {formatDateTime(e.starts_at)}
              {" → "}
              {e.ends_at ? (
                formatDateTime(e.ends_at)
              ) : e.etr ? (
                <span title="Estimated time to restore">
                  ETR {formatDateTime(e.etr)}
                </span>
              ) : (
                <span className="text-muted-foreground">open</span>
              )}
            </span>
          )
        },
      },
      {
        id: "impacts",
        header: "Impacts",
        cell: ({ row }) => (
          <span className="num">{row.original.impacts.length}</span>
        ),
      },
      {
        id: "ref",
        header: "Reference",
        cell: ({ row }) =>
          row.original.external_ref ? (
            <span className="font-mono text-[12px]">
              {row.original.external_ref}
            </span>
          ) : null,
      },
      {
        id: "updated",
        header: "Updated",
        cell: ({ row }) => <TimeCell iso={row.original.updated_at} />,
      },
      actionsColumn<MaintenanceEvent>({
        editTo: "/maintenance/$id/edit",
        editParams: (e) => ({ id: e.id }),
        canEdit: () => canEdit,
      }),
    ],
    [canEdit, formatDateTime]
  )

  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, allRows)

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
        columns={columns}
        tableId="maintenance-events"
        flexColumn="name"
      />
    </ListPageShell>
  )
}
