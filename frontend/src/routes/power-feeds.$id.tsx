import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { PowerFeed } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { TagList } from "@/components/cells/tag-list"
import { RackCell } from "@/components/cells/rack-cell"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { StatusBadge } from "@/components/status-badge"
import { QueryError } from "@/components/query-error"
import { PowerFeedDeleteDialog } from "@/components/power-feed-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { EmbeddedCableTable } from "@/components/embedded-tables"
import { fmtPower } from "@/components/columns/power-feed-columns"

export const Route = createFileRoute("/power-feeds/$id")({
  component: PowerFeedDetail,
})

function PowerFeedDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["power-feed", id],
    queryFn: () => api<PowerFeed>(`/api/power-feeds/${id}/`),
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
  return <Body feed={q.data} />
}

/** The panel this feed draws from — its own page, one hop up the power path. */
function PanelLink({ panel }: { panel: { id: string; name: string } }) {
  return (
    <Link
      to="/power-panels/$id"
      params={{ id: panel.id }}
      className="text-primary hover:underline"
    >
      {panel.name}
    </Link>
  )
}

function Body({ feed: f }: { feed: PowerFeed }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "terminations" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<PowerFeed | null>(null)
  const goBack = useCallback(() => nav({ to: "/power-feeds" }), [nav])

  return (
    <DetailShell
      backTo="/power-feeds"
      backLabel="Power feeds"
      title={f.name}
      presence={{ type: "powerfeed", id: f.id }}
      actions={
        <>
          {canDo("powerfeed", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/power-feeds/$id/edit" params={{ id: f.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("powerfeed", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(f)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <DetailHero
            title={f.name}
            badges={<StatusBadge status={f.status} />}
            subtitle={
              <>
                <PanelLink panel={f.power_panel} />
                {f.rack && (
                  <>
                    <span aria-hidden="true">·</span>
                    <RackCell rack={f.rack} />
                  </>
                )}
              </>
            }
            tags={f.tags.length > 0 && <TagList tags={f.tags} />}
            statCols={3}
            stats={
              <>
                <DetailStat
                  label="Rating"
                  value={<span className="num">{fmtPower(f)}</span>}
                />
                <DetailStat label="Type" value={f.type_display} />
                <DetailStat
                  label="Max util."
                  value={<span className="num">{f.max_utilization}%</span>}
                />
              </>
            }
          />
          <CustomFieldValues model="powerfeed" values={f.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "terminations", label: "Terminations" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <FeedOverview feed={f} />
      </DetailTab>
      <DetailTab value="terminations">
        <EmbeddedCableTable
          filter={{ power_feed: f.id }}
          emptyText="Nothing is cabled to this feed yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.powerfeed" objectId={f.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.powerfeed" objectId={f.id} />
      </DetailTab>

      <PowerFeedDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function FeedOverview({ feed: f }: { feed: PowerFeed }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && f.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{f.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: f.name, copy: f.name },
    // A feed always draws from a panel — the FK is non-nullable.
    { label: "Panel", value: <PanelLink panel={f.power_panel} /> },
    { label: "Rack", value: f.rack ? <RackCell rack={f.rack} /> : dash },
    { label: "Status", value: <StatusBadge status={f.status} /> },
    { label: "Type", value: f.type_display || dash },
  ]

  // Only what the feed records. Danbyte does not compute a draw against this
  // ceiling, so the page states the ceiling and leaves it at that.
  const electrical: KvRow[] = [
    { label: "Supply", value: f.supply_display || dash },
    { label: "Phase", value: f.phase_display || dash },
    {
      label: "Voltage",
      value:
        f.voltage != null ? <span className="num">{f.voltage} V</span> : dash,
    },
    {
      label: "Amperage",
      value:
        f.amperage != null ? <span className="num">{f.amperage} A</span> : dash,
    },
    {
      label: "Max utilization",
      value: <span className="num">{f.max_utilization}%</span>,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={f.created_at} /> },
    { label: "Updated", value: <TimeCell iso={f.updated_at} /> },
  ]

  const notes: KvRow[] = [
    {
      label: "Comments",
      value: f.comments ? (
        <span className="whitespace-pre-wrap">{f.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Feed" rows={details} />
      <KvCard title="Electrical" rows={electrical} />
      <KvCard title="Record" rows={record} />
      <KvCard title="Notes" rows={notes} />
    </div>
  )
}
