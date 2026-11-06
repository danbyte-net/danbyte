import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import type { ColumnDef } from "@tanstack/react-table"
import { Waypoints } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import type { Cable } from "@/lib/api"
import { useServerList } from "@/lib/server-list"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildCableColumns } from "@/components/columns/cable-columns"
import { wireFacetColumns } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { CableDeleteDialog } from "@/components/cable-delete-dialog"
import { CableTraceDialog } from "@/components/cable-trace-dialog"
import { cableTint } from "@/components/cable-status-control"
import type { CableTraceTarget } from "@/components/cable-trace-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/cables/")({ component: CablesPage })

/** The rail's facets, counted and filtered by the server (api/list_specs.py). */
const CABLE_FACETS = ["type", "status", "tags"]
// Strand counts only mean anything for fibre - /fiber-cables owns them.
const OMIT = ["strands", "labelled"] as const

function CablesPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<Cable | null>(null)
  const [tracing, setTracing] = useState<CableTraceTarget | null>(null)

  const { canDo, humanIds } = useMe()
  const canAdd = canDo("cable", "add")
  const canEdit = canDo("cable", "change")
  const canDelete = canDo("cable", "delete")

  // One page at a time from the server (#482).
  const facetColumns = useMemo(() => buildCableColumns({ omit: [...OMIT] }), [])
  const list = useServerList<Cable>({
    endpoint: "/api/cables/",
    queryKey: "cables",
    columns: facetColumns,
    facets: CABLE_FACETS,
  })
  const { query, rows, selectedValues, toggleValue } = list

  const handleDelete = useCallback((c: Cable) => setDeleting(c), [])
  const handleTrace = useCallback(
    (c: Cable) =>
      setTracing({ id: c.id, label: c.label || `Cable #${c.numid}` }),
    []
  )
  const columns = useMemo<ColumnDef<Cable>[]>(
    () =>
      wireFacetColumns(
        [
          ...buildCableColumns({
            omit: [...OMIT],
            selection: true,
            humanIds,
            statusEditable: canEdit,
          }),
          // Page-specific: the trace button rides alongside Edit/Delete in
          // its own flex row, so this pane keeps its own actions column.
          {
            id: "actions",
            enableHiding: false,
            cell: ({ row }) => (
              <div className="flex items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  title="Trace this run"
                  aria-label={`Trace ${row.original.label || "cable"}`}
                  onClick={() => handleTrace(row.original)}
                >
                  <Waypoints className="h-3.5 w-3.5" />
                </Button>
                <RowActions
                  editTo={canEdit ? "/cables/$id/edit" : undefined}
                  editParams={{ id: row.original.id }}
                  onDelete={
                    canDelete ? () => handleDelete(row.original) : undefined
                  }
                />
              </div>
            ),
          },
        ],
        selectedValues,
        toggleValue
      ),
    [
      handleDelete,
      handleTrace,
      canEdit,
      canDelete,
      humanIds,
      selectedValues,
      toggleValue,
    ]
  )
  const { rail, snapshot, restore, activeCount } = list

  return (
    <ListPageShell
      title="Cables"
      count={query.data ? list.total : undefined}
      rail={rail}
      savedViews={{
        objectType: "cable",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by device, port…",
      }}
      actions={
        <>
          <TableActions ioType="cable" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cables/new">Add cable</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        {...list.tableProps}
        flexColumn="description"
        tableId="cables"
        rowStyle={(c) => cableTint(c.status)}
      />
      <CableDeleteDialog
        cable={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <CableTraceDialog
        target={tracing}
        onOpenChange={(o) => !o && setTracing(null)}
      />
    </ListPageShell>
  )
}
