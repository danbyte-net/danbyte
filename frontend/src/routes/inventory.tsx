import { useMemo } from "react"
import type { ReactNode } from "react"
import { createFileRoute } from "@tanstack/react-router"

import type { InventoryCountRow, InventoryEntryRow } from "@/lib/api"
import { useServerList } from "@/lib/server-list"
import { useListSearch, useSearchWriter, useUrlSearch } from "@/lib/url-filters"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { wireFacetColumns } from "@/components/table-filters"
import {
  buildInventoryColumns,
  buildInventoryCountColumns,
} from "@/components/columns/inventory-entry-columns"

// DCIM → Inventory (docs/dcim/stock.md): every part the tenant has - in a
// port, in a bay, loose on a device, or in stock at a site and location -
// with its status. Stock is the same list narrowed to the stock pool;
// Counts groups the rows by part and place. Paged, sorted and counted on
// the server (/api/inventory/).

export const Route = createFileRoute("/inventory")({
  component: InventoryPage,
})

type View = "all" | "stock" | "counts"

const VIEWS = [
  { value: "all", label: "All" },
  { value: "stock", label: "Stock" },
  { value: "counts", label: "Counts" },
] as const

function InventoryPage() {
  const search = useListSearch()
  const write = useSearchWriter()
  const view: View =
    search.view === "stock" || search.view === "counts" ? search.view : "all"
  // A view's filters are its own: switching starts clean.
  const viewSwitch = (
    <SegmentedTabs<View>
      label="Inventory views"
      value={view}
      onValueChange={(v) => write(() => (v === "all" ? {} : { view: v }))}
      items={VIEWS}
    />
  )
  return view === "counts" ? (
    <InventoryCounts viewSwitch={viewSwitch} />
  ) : (
    <InventoryItems
      key={view}
      stock={view === "stock"}
      viewSwitch={viewSwitch}
    />
  )
}

const FACETS = ["status", "kind", "home", "site", "location", "manufacturer"]

function InventoryItems({
  stock,
  viewSwitch,
}: {
  stock: boolean
  viewSwitch: ReactNode
}) {
  const [search, setSearch] = useUrlSearch()
  const facetColumns = useMemo(() => buildInventoryColumns(), [])
  const list = useServerList<InventoryEntryRow>({
    endpoint: "/api/inventory/",
    queryKey: "inventory",
    columns: facetColumns,
    facets: stock ? FACETS.filter((f) => f !== "home") : FACETS,
    params: stock ? { f_home: "stock" } : undefined,
    savedViews: stock ? undefined : "inventoryitem",
  })
  const { selectedValues, toggleValue } = list
  const columns = useMemo(
    () => wireFacetColumns(facetColumns, selectedValues, toggleValue),
    [facetColumns, selectedValues, toggleValue]
  )
  return (
    <ListPageShell
      title="Inventory"
      count={list.query.data ? list.total : undefined}
      rail={list.rail}
      savedViews={list.savedViews}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter by serial, part, device…",
      }}
      actions={viewSwitch}
      query={list.query}
    >
      <DataTable
        data={list.rows}
        columns={columns}
        {...list.tableProps}
        flexColumn="name"
        tableId={stock ? "inventory-stock" : "inventory"}
        exportName={stock ? "stock" : "inventory"}
        exportTitle={stock ? "Stock" : "Inventory"}
      />
    </ListPageShell>
  )
}

const COUNT_FACETS = ["kind", "site", "location", "manufacturer"]
const COUNT_EXTRA = [
  { id: "status", label: "Status", kind: "enum" as const },
  { id: "home", label: "Where", kind: "enum" as const },
]

function InventoryCounts({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [search, setSearch] = useUrlSearch()
  const facetColumns = useMemo(() => buildInventoryCountColumns(), [])
  const list = useServerList<InventoryCountRow>({
    endpoint: "/api/inventory/counts/",
    queryKey: "inventory",
    columns: facetColumns,
    facets: COUNT_FACETS,
    extraFacets: COUNT_EXTRA,
  })
  const { selectedValues, toggleValue } = list
  const columns = useMemo(
    () => wireFacetColumns(facetColumns, selectedValues, toggleValue),
    [facetColumns, selectedValues, toggleValue]
  )
  return (
    <ListPageShell
      title="Inventory"
      count={list.query.data ? list.total : undefined}
      rail={list.rail}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter by serial, part, device…",
      }}
      actions={viewSwitch}
      query={list.query}
    >
      <DataTable
        data={list.rows}
        columns={columns}
        {...list.tableProps}
        flexColumn="part"
        tableId="inventory-counts"
        exportName="inventory-counts"
        exportTitle="Inventory counts"
      />
    </ListPageShell>
  )
}
