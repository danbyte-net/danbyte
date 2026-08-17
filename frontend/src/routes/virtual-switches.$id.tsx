import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type VirtualSwitch } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
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
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
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
      <DetailTab value="journal">
        <JournalPanel objectType="api.virtualswitch" objectId={sw.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.virtualswitch" objectId={sw.id} />
      </DetailTab>
    </DetailShell>
  )
}
