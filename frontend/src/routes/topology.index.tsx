import { useMemo, useState } from "react"
import { Link, createFileRoute, redirect } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { FileText, Network } from "lucide-react"

import type { TopologyViewListRow } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { usePageTitle } from "@/lib/page-title"
import { useUrlSearch } from "@/lib/url-filters"
import { useMe } from "@/lib/use-me"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { topologyViewColumns } from "@/components/columns/topology-view-columns"
import { useObjectReport } from "@/components/object-report"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { drawSavedView } from "@/components/topology/report-bridge"
import { isMapSearch } from "@/components/topology/views-list"
import { Button } from "@/components/ui/button"

// The Topology page: the tenant's saved views. The map itself is at
// `/topology/map`; a link to `/topology` that names a view, site, device,
// tab… is an old map link and goes on to the map with everything it named.

export const Route = createFileRoute("/topology/")({
  beforeLoad: ({ search }) => {
    if (isMapSearch(search))
      throw redirect({
        to: "/topology/map",
        search: search as never,
        replace: true,
      })
  },
  component: TopologyViewsPage,
})

function TopologyViewsPage() {
  usePageTitle("Topology")
  const { canDo } = useMe()
  const [q, setQ] = useUrlSearch("search")
  const query = useQuery({
    queryKey: ["topology-views", "summary"],
    queryFn: () =>
      apiAll<TopologyViewListRow>("/api/topology-views/?summary=1"),
  })
  const [selected, setSelected] = useState<TopologyViewListRow[]>([])
  const columns = useMemo(() => topologyViewColumns({ selection: true }), [])
  const rows = useMemo(
    () =>
      (query.data?.results ?? []).filter((v) =>
        `${v.name} ${v.created_by} ${v.updated_by}`
          .toLowerCase()
          .includes(q.toLowerCase())
      ),
    [query.data, q]
  )
  const report = useObjectReport("topology")
  const openReport = () =>
    report.openReport({
      ids: selected.map((v) => v.id),
      scope: selected.length === 1 ? "one" : "selected",
      name: selected.length === 1 ? selected[0].name : undefined,
      // Each view drawn off screen in the map page, as its Export ▸ PDF
      // draws it (report-bridge.tsx).
      views: selected.map((v) => ({
        id: v.id,
        name: v.name,
        draw: () => drawSavedView(v.id),
      })),
    })
  return (
    <ListPageShell
      title="Topology"
      count={query.data ? rows.length : undefined}
      search={{ value: q, onChange: setQ, placeholder: "View name…" }}
      actions={
        <Button size="sm" asChild>
          <Link to="/topology/map">
            <Network className="h-3.5 w-3.5" /> Open map
          </Link>
        </Button>
      }
      query={query}
    >
      <DataTable
        columns={columns}
        data={rows}
        tableId="topology-views"
        exportName="topology-views"
        exportTitle="Topology views"
        onSelectedRowsChange={setSelected}
        selectedRows={selected}
      />
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/topology-views/"
        noun={["view", "views"]}
        invalidate={[["topology-views"]]}
        onCleared={() => setSelected([])}
        canDelete={canDo("topologyview", "delete")}
        actions={
          <Button size="sm" variant="outline" onClick={openReport}>
            <FileText className="h-3.5 w-3.5" /> PDF report…
          </Button>
        }
      />
      {report.dialog}
    </ListPageShell>
  )
}
