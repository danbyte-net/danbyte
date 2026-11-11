import { useMemo, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { InventoryProfile, InventoryRun } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useUrlTableFilters } from "@/components/table-filters"
import {
  buildInventoryProfileColumns,
  buildInventoryRunColumns,
} from "@/components/columns/inventory-columns"
import { useMonitoringCrumb } from "@/components/monitoring/monitoring-tabs"
import { ProfileDialog } from "./profile-dialog"
import { useDiscoveryStatus } from "./status"

// Discovery under Monitoring (#451): the tenant's discovery profiles and the
// latest runs, on /discovery; Findings and Open ports are the tabs beside it
// (DiscoveryFrame). Its settings are under Monitoring → Settings → Host
// discovery.

/** Whether the Monitoring page shows the Discovery tab: Discovery on for
 *  the tenant (and the deployment), and the caller may view profiles. */
export function useDiscoveryTab(): boolean {
  const { canDo } = useMe()
  const status = useDiscoveryStatus()
  return !!status.data?.active && canDo("inventoryprofile", "view")
}

export function DiscoveryTab() {
  const visible = useDiscoveryTab()
  const status = useDiscoveryStatus()
  const { canDo, canManage } = useMe()
  const nav = useNavigate()
  const [q, setQ] = useUrlSearch()
  const [creating, setCreating] = useState(false)
  const profiles = useQuery({
    queryKey: ["discovery", "profiles", q],
    queryFn: () =>
      apiAll<InventoryProfile>(
        `/api/discovery/profiles/?${new URLSearchParams({ search: q }).toString()}`
      ),
    enabled: visible,
  })
  const rows = useMemo(() => profiles.data?.results ?? [], [profiles.data])
  const columns = useMemo(() => buildInventoryProfileColumns(), [])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)
  const crumb = useMonitoringCrumb()

  if (status.isLoading) return <Loading />
  if (!visible)
    return (
      <div className="p-6">
        <EmptyState title="Discovery is off">
          {status.data?.deployment_enabled
            ? "Turn it on under Settings → Integrations."
            : "This deployment does not allow discovery."}
        </EmptyState>
      </div>
    )

  return (
    <ListPageShell
      {...crumb}
      title="Discovery"
      count={profiles.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          {canManage && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/monitoring/settings" hash="host-discovery">
                Settings
              </Link>
            </Button>
          )}
          {canDo("inventoryprofile", "add") && (
            <Button size="sm" onClick={() => setCreating(true)}>
              Add profile
            </Button>
          )}
        </>
      }
      query={profiles}
    >
      <DataTable
        data={filteredRows}
        total={profiles.data?.count}
        columns={wired}
        flexColumn="description"
        tableId="inventory-profiles"
      />
      <RecentRuns />
      <ProfileDialog
        open={creating}
        onOpenChange={setCreating}
        profile={null}
        onSaved={(p) => nav({ to: "/discovery/$id", params: { id: p.id } })}
      />
    </ListPageShell>
  )
}

/** The newest runs of every profile the caller may view. */
function RecentRuns() {
  const runs = useQuery({
    queryKey: ["discovery", "runs", "recent"],
    queryFn: () =>
      api<{ count: number; results: InventoryRun[] }>(
        "/api/discovery/runs/?page_size=10"
      ),
  })
  const columns = useMemo(() => buildInventoryRunColumns(), [])
  return (
    <section className="border-t border-border">
      <h2 className="px-4 pt-3 pb-1 text-sm font-semibold lg:px-6">
        Recent runs
      </h2>
      {runs.isLoading ? (
        <Loading />
      ) : runs.isError ? (
        <QueryError error={runs.error} />
      ) : (runs.data?.results ?? []).length === 0 ? (
        <EmptyState title="No runs yet" />
      ) : (
        <DataTable
          data={runs.data!.results}
          columns={columns}
          flexColumn="profile"
          tableId="inventory-recent-runs"
          autoColumns={false}
        />
      )}
    </section>
  )
}
