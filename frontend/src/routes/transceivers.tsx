import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo } from "react"

import type { InventoryItemRow } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { useUrlTableFilters } from "@/components/table-filters"
import {
  TRANSCEIVER_COLUMNS,
  buildInventoryItemColumns,
} from "@/components/columns/inventory-item-columns"

export const Route = createFileRoute("/transceivers")({
  component: TransceiversPage,
})

/**
 * DCIM → Transceivers (docs/dcim/inventory.md → Transceivers list): every
 * inventory item of kind transceiver in the tenant - in a port or spare -
 * with its part, serial, standard, device, port, cable and site.
 */
function TransceiversPage() {
  const [q, setQ] = useUrlSearch()
  const { canDo } = useMe()
  const linkTypes = canDo("moduletype", "view")
  const query = useQuery({
    queryKey: ["transceivers", q],
    queryFn: () =>
      apiAll<InventoryItemRow>(
        `/api/inventory-items/?${new URLSearchParams({
          kind: "transceiver",
          search: q,
        }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const columns = useMemo<ColumnDef<InventoryItemRow, unknown>[]>(
    () =>
      buildInventoryItemColumns({
        include: TRANSCEIVER_COLUMNS,
        linkTypes,
        facets: true,
      }),
    [linkTypes]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Transceivers"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "inventoryitem",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by serial, part, device…",
      }}
      query={query}
    >
      {rows.length === 0 && !q ? (
        <p className="max-w-xl text-sm text-muted-foreground">
          No transceivers yet. Record them in a device's inventory or set one on
          an interface.
        </p>
      ) : (
        <DataTable
          data={filteredRows}
          columns={wiredColumns}
          flexColumn="name"
          tableId="transceivers"
        />
      )}
    </ListPageShell>
  )
}
