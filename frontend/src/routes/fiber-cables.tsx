import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Cable, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { buildCableColumns } from "@/components/columns/cable-columns"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/fiber-cables")({
  component: FiberCablesPage,
})

function FiberCablesPage() {
  const [q, setQ] = useState("")
  const { humanIds } = useMe()

  const query = useQuery({
    queryKey: ["fiber-cables", q],
    queryFn: () =>
      api<Paginated<Cable>>(
        `/api/cables/?${new URLSearchParams({ fiber: "1", search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo<ColumnDef<Cable>[]>(
    () =>
      buildCableColumns({
        // Strands/labelled take the description column's place here.
        omit: ["description"],
        selection: true,
        humanIds,
        labelVariant: "numbered",
        terminationsLinked: false,
      }),
    [humanIds]
  )
  const { rail, filteredRows, activeCount } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Fibre cables"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by device, port…",
      }}
      query={query}
    >
      {rows.length === 0 && !q && activeCount === 0 ? (
        <EmptyState title="No fibre cables yet.">
          A cable becomes fibre when its type is a single-mode (smf*) or
          multimode (mmf*) medium.
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={columns}
          flexColumn="a"
          tableId="fiber-cables"
        />
      )}
    </ListPageShell>
  )
}
