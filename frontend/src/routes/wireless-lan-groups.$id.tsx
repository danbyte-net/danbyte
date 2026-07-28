import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { WirelessLANGroup } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { WlanGroupDeleteDialog } from "@/components/wlan-group-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { EmbeddedWirelessLANTable } from "@/components/embedded-tables"

export const Route = createFileRoute("/wireless-lan-groups/$id")({
  component: WlanGroupDetail,
})

function WlanGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["wireless-lan-group", id],
    queryFn: () => api<WirelessLANGroup>(`/api/wireless-lan-groups/${id}/`),
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
  return <Body group={q.data} />
}

function Body({ group: g }: { group: WirelessLANGroup }) {
  const [tab, setTab] = useUrlTab<"overview" | "wlans" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<WirelessLANGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/wireless-lan-groups" }), [nav])

  return (
    <DetailShell
      backTo="/wireless-lan-groups"
      backLabel="Wireless LAN groups"
      title={g.name}
      presence={{ type: "wirelesslangroup", id: g.id }}
      actions={
        <>
          {canDo("wirelesslangroup", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/wireless-lan-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("wirelesslangroup", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(g)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={g.name}
          description={g.description}
          statCols={1}
          stats={
            <DetailStat
              label="Wireless LANs"
              value={<span className="num">{g.wlan_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "wlans", label: "Wireless LANs", count: g.wlan_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <WlanGroupOverview group={g} />
      </DetailTab>
      <DetailTab value="wlans">
        <EmbeddedWirelessLANTable
          filter={{ group: g.id }}
          omitGroup
          emptyText="No wireless LANs belong to this group yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.wirelesslangroup" objectId={g.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.wirelesslangroup" objectId={g.id} />
      </DetailTab>

      <WlanGroupDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Wireless-LAN-group attributes. The name, description and WLAN count stay in
 * the hero; everything else lands here. */
function WlanGroupOverview({ group: g }: { group: WirelessLANGroup }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && g.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{g.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: g.name, copy: g.name },
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{g.slug}</span>,
      copy: g.slug,
    },
    { label: "Description", value: g.description || dash },
    {
      label: "Wireless LANs",
      value: <span className="num">{g.wlan_count}</span>,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={g.created_at} /> },
    { label: "Updated", value: <TimeCell iso={g.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Wireless LAN group" rows={details} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}
