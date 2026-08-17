import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import {
  api,
  type Paginated,
  type VirtNetwork,
  type VirtualSwitch,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useUrlTab } from "@/lib/use-url-tab"

export const Route = createFileRoute("/virtual-switches/$id")({
  component: VirtualSwitchDetail,
})

function VirtualSwitchDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["virtual-switch", id],
    queryFn: () => api<VirtualSwitch>(`/api/virtual-switches/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body sw={q.data} />
}

function Body({ sw }: { sw: VirtualSwitch }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "networks" | "journal" | "history"
  >("overview")
  const networks = useQuery({
    queryKey: ["virt-networks", { vswitch: sw.id }],
    queryFn: () =>
      api<Paginated<VirtNetwork>>(`/api/virt-networks/?vswitch=${sw.id}`),
  })
  const nets = networks.data?.results ?? []
  const rows: KvRow[] = [
    {
      label: "Kind",
      value: sw.kind_display ? (
        <Badge variant="outline" className="text-[10px]">
          {sw.kind_display}
        </Badge>
      ) : (
        dash
      ),
    },
    {
      label: "Cluster",
      value: sw.cluster ? (
        <Link
          to="/clusters/$id"
          params={{ id: sw.cluster.id }}
          className="link"
        >
          {sw.cluster.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Uplinks",
      value: sw.uplinks ? (
        <span className="font-mono text-xs">{sw.uplinks}</span>
      ) : (
        dash
      ),
    },
    {
      label: "MTU",
      value: sw.mtu != null ? <span className="num">{sw.mtu}</span> : dash,
    },
    { label: "Source", value: sw.created_switch ? "Synced" : "Manual" },
    { label: "Created", value: <TimeCell iso={sw.created_at} /> },
    { label: "Updated", value: <TimeCell iso={sw.updated_at} /> },
  ]

  return (
    <DetailShell
      backTo="/virtual-switches"
      backLabel="Virtual switches"
      title={sw.name}
      presence={{ type: "virtualswitch", id: sw.id }}
      hero={
        <DetailHero
          title={sw.name}
          description={sw.description}
          statCols={1}
          stats={
            <DetailStat
              label="Kind"
              value={<span className="text-xs">{sw.kind_display || "—"}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "networks", label: "Networks", count: nets.length },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Virtual switch" rows={rows} />
        </div>
      </DetailTab>
      <DetailTab value="networks">
        <SwitchNetworks nets={nets} loading={networks.isLoading} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.virtualswitch" objectId={sw.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.virtualswitch" objectId={sw.id} />
      </DetailTab>
    </DetailShell>
  )
}

/** The networks (port-groups / bridges) on this switch, each with its VLAN and
 * the VMs attached — the switch→network→VM chain. */
function SwitchNetworks({
  nets,
  loading,
}: {
  nets: VirtNetwork[]
  loading: boolean
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (nets.length === 0)
    return (
      <EmptyState title="No networks on this switch yet.">
        Networks appear once a sync with{" "}
        <span className="font-medium">virtual switches &amp; networks</span>{" "}
        enabled has run — each port-group/bridge is mapped to a VLAN and the VMs
        on it are linked here.
      </EmptyState>
    )
  return (
    <div className="space-y-4">
      {nets.map((n) => (
        <div key={n.id} className="rounded-lg border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="font-medium">{n.name || n.ext_key}</span>
            {n.vlan ? (
              <Link
                to="/vlans/$id"
                params={{ id: n.vlan.id }}
                className="link font-mono text-xs text-muted-foreground"
              >
                VLAN {n.vlan.vlan_id} · {n.vlan.name}
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">no VLAN</span>
            )}
            <Badge variant="secondary" className="ml-auto text-[10px]">
              {n.vms.length} VM{n.vms.length === 1 ? "" : "s"}
            </Badge>
          </div>
          {n.vms.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 py-3">
              {n.vms.map((vm) => (
                <Link
                  key={vm.id}
                  to="/virtual-machines/$id"
                  params={{ id: vm.id }}
                  className="link rounded-md border border-border px-2 py-0.5 text-xs"
                >
                  {vm.name}
                </Link>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
