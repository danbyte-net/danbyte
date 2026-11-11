import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { api } from "@/lib/api"
import type { InventoryHostResult, InventoryRun, Paginated } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useUrlTableFilters } from "@/components/table-filters"
import { useUrlTab } from "@/lib/use-url-tab"
import { buildInventoryHostResultColumns } from "@/components/columns/inventory-columns"
import { HostKeysPanel } from "@/components/discovery/host-keys-panel"
import {
  FindingsPanel,
  ObservedServicesPanel,
} from "@/components/discovery/findings-panel"
import { isRunActive, RunStatusBadge } from "@/components/discovery/status"

// One discovery run (#451 B2): what it did, then a row per host it
// considered - read, refused, or left alone and why - and the host keys
// its hosts presented that wait for review. Hosts you may not view are not
// listed.

type Tab = "overview" | "hosts" | "findings" | "services" | "keys"
const TABS: readonly Tab[] = [
  "overview",
  "hosts",
  "findings",
  "services",
  "keys",
]

export const Route = createFileRoute("/discovery/runs/$runId")({
  component: RunDetail,
})

function RunDetail() {
  const { runId } = Route.useParams()
  const q = useQuery({
    queryKey: ["discovery", "run", runId],
    queryFn: () => api<InventoryRun>(`/api/discovery/runs/${runId}/`),
    refetchInterval: (query) =>
      query.state.data && isRunActive(query.state.data.status) ? 3000 : false,
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body run={q.data} />
}

function n(r: InventoryRun, k: string) {
  return <span className="num">{r.counts[k] ?? 0}</span>
}

function Body({ run: r }: { run: InventoryRun }) {
  const [tab, setTab] = useUrlTab<Tab>("hosts", "tab", TABS)
  const hosts = useQuery({
    queryKey: ["discovery", "run", r.id, "hosts", r.status],
    queryFn: () =>
      apiAll<InventoryHostResult>(`/api/discovery/runs/${r.id}/hosts/`),
  })
  const rows: KvRow[] = [
    {
      label: "Profile",
      value: (
        <Link
          to="/discovery/$id"
          params={{ id: r.profile.id }}
          className="link"
        >
          {r.profile.name}
        </Link>
      ),
    },
    {
      label: "Started by",
      value: r.trigger === "schedule" ? "Schedule" : r.started_by_name || dash,
    },
    { label: "Ran on", value: r.engine === "server" ? "Server" : r.engine },
    { label: "Queued", value: <TimeCell iso={r.created_at} /> },
    {
      label: "Finished",
      value: r.finished_at ? <TimeCell iso={r.finished_at} /> : dash,
    },
  ]
  const scan = r.kind === "service_scan"
  const counts: KvRow[] = scan
    ? [
        { label: "Addresses", value: n(r, "hosts") },
        { label: "Scanned", value: n(r, "ok") },
        { label: "Open ports", value: n(r, "services") },
        { label: "New", value: n(r, "new") },
        { label: "Closed since", value: n(r, "gone") },
        { label: "Connections", value: n(r, "connects") },
        { label: "Ports per address", value: n(r, "ports") },
        { label: "Connects per second", value: n(r, "rate") },
        { label: "Addresses at once", value: n(r, "hosts_parallel") },
      ]
    : [
        { label: "Hosts", value: n(r, "hosts") },
        { label: "Read", value: n(r, "ok") },
        { label: "Packages", value: n(r, "packages") },
        { label: "Changed hosts", value: n(r, "changed") },
      ]
  const errors: KvRow[] = r.errors.map((e, i) => ({
    label: `${i + 1}`,
    value: <span className="text-sm">{e}</span>,
  }))
  return (
    <DetailShell
      backTo="/discovery/$id"
      backParams={{ id: r.profile.id }}
      backLabel={r.profile.name}
      title={`Run of ${r.profile.name}`}
      hero={
        <DetailHero
          title={`Run of ${r.profile.name}`}
          badges={<RunStatusBadge status={r.status} />}
        />
      }
      tabs={[
        {
          value: "hosts",
          label: scan ? "Addresses" : "Hosts",
          count: hosts.data?.count,
        },
        ...(scan
          ? [
              { value: "findings" as const, label: "Findings" },
              { value: "services" as const, label: "Open ports" },
            ]
          : []),
        { value: "keys", label: "Host keys" },
        { value: "overview", label: "Overview" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Run" rows={rows} />
          <div className="grid min-w-0 content-start gap-6">
            <KvCard title="Counts" rows={counts} />
            {errors.length > 0 && <KvCard title="Messages" rows={errors} />}
          </div>
        </div>
      </DetailTab>
      <DetailTab value="hosts">
        <div className="space-y-3">
          <Summary run={r} onKeys={() => setTab("keys")} />
          <Hosts query={hosts} scan={scan} />
        </div>
      </DetailTab>
      {scan && (
        <>
          <DetailTab value="findings">
            <FindingsPanel scope={{ run: r.id }} />
          </DetailTab>
          <DetailTab value="services">
            <ObservedServicesPanel scope={{ run: r.id }} />
          </DetailTab>
        </>
      )}
      <DetailTab value="keys">
        <HostKeysPanel
          endpoint={`/api/discovery/runs/${r.id}/host-keys/`}
          queryKey={["discovery", "run", r.id, "host-keys"]}
        />
      </DetailTab>
    </DetailShell>
  )
}

/** The run in one line by reason, with the way out when nothing was read
 * for want of a login or an accepted key. */
function Summary({
  run: r,
  onKeys,
}: {
  run: InventoryRun
  onKeys: () => void
}) {
  if (!r.summary || isRunActive(r.status)) return null
  const noCred = (r.counts.no_credential ?? 0) > 0
  const noKey = (r.counts.host_key_refused ?? 0) > 0
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <span>{r.summary}</span>
      {noCred && (
        <Link to="/settings/credentials" className="link">
          Shared credentials
        </Link>
      )}
      {noKey && (
        <button type="button" className="link" onClick={onKeys}>
          Review host keys
        </button>
      )}
    </div>
  )
}

function Hosts({
  query,
  scan,
}: {
  query: ReturnType<typeof useQuery<Paginated<InventoryHostResult>>>
  scan: boolean
}) {
  const columns = useMemo(
    () => buildInventoryHostResultColumns({ scan }),
    [scan]
  )
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)
  if (query.isLoading) return <Loading />
  if (query.isError) return <QueryError error={query.error} />
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <DataTable
          data={filteredRows}
          total={query.data?.count}
          columns={wired}
          flexColumn="message"
          tableId="inventory-run-hosts"
          searchable
          searchPlaceholder="Search hosts…"
          autoColumns={false}
        />
      </div>
    </div>
  )
}
