import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import { api } from "@/lib/api"
import type { NamedDashboard, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { useTableFilters } from "@/components/table-filters"
import { dashboardColumns } from "@/components/columns/dashboard-columns"
import { DashboardSettingsDialog } from "@/components/dashboard/dashboard-settings"

export const Route = createFileRoute("/dashboards/")({
  component: DashboardsPage,
})

function DashboardsPage() {
  const nav = useNavigate()
  const [creating, setCreating] = useState(false)
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["dashboards"],
    queryFn: () =>
      api<Paginated<NamedDashboard>>("/api/dashboards/?page_size=200"),
  })
  const columns = useMemo(() => dashboardColumns(), [])
  const rows = useMemo(
    () =>
      (query.data?.results ?? []).filter((d) =>
        `${d.name} ${d.description}`.toLowerCase().includes(q.toLowerCase())
      ),
    [query.data, q]
  )
  const { rail, filteredRows, columns: wired } = useTableFilters(columns, rows)
  return (
    <ListPageShell
      title="Dashboards"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Name or description…" }}
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" /> New dashboard
        </Button>
      }
      query={query}
    >
      <DataTable
        columns={wired}
        data={filteredRows}
        tableId="dashboards"
        exportName="dashboards"
        exportTitle="Dashboards"
        flexColumn="description"
      />
      <DashboardSettingsDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={(d) => nav({ to: "/dashboards/$id", params: { id: d.id } })}
      />
    </ListPageShell>
  )
}
