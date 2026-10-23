import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { CoolingFeed } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { TagList } from "@/components/cells/tag-list"
import { RackCell } from "@/components/cells/rack-cell"
import { SiteCell } from "@/components/cells/site-cell"
import { CoolingFigure } from "@/components/cells/power-figure"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { StatusBadge } from "@/components/status-badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { CoolingFeedDeleteDialog } from "@/components/cooling-feed-delete-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { AffectedPanel } from "@/components/feed-affected-panel"
import { UpcomingMaintenancePanel } from "@/components/monitoring/upcoming-maintenance"
import { fmtRating } from "@/components/columns/cooling-source-columns"
import {
  feedCooling,
  fmtDecimal,
} from "@/components/columns/cooling-feed-columns"

export const Route = createFileRoute("/cooling-feeds/$id")({
  component: CoolingFeedDetail,
})

function CoolingFeedDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cooling-feed", id],
    queryFn: () => api<CoolingFeed>(`/api/cooling-feeds/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body feed={q.data} />
}

/** The source this feed runs from - one hop up the cooling path. */
function SourceLink({ source }: { source: { id: string; name: string } }) {
  return (
    <Link to="/cooling-sources/$id" params={{ id: source.id }} className="link">
      {source.name}
    </Link>
  )
}

function Body({ feed: f }: { feed: CoolingFeed }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "affected" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<CoolingFeed | null>(null)
  const goBack = useCallback(() => nav({ to: "/cooling-feeds" }), [nav])

  return (
    <DetailShell
      backTo="/cooling-feeds"
      backLabel="Cooling feeds"
      title={f.name}
      presence={{ type: "coolingfeed", id: f.id }}
      actions={
        <>
          {canDo("coolingfeed", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cooling-feeds/$id/edit" params={{ id: f.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("coolingfeed", "delete") && (
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
        <DetailHero
          title={f.name}
          badges={<StatusBadge status={f.status} />}
          subtitle={
            <>
              <SourceLink source={f.source} />
              {f.rack && (
                <>
                  <span aria-hidden="true">·</span>
                  <RackCell rack={f.rack} />
                </>
              )}
            </>
          }
          tags={
            f.tags.length > 0 && (
              <TagList tags={f.tags} listTo="/cooling-feeds" />
            )
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "affected", label: "Affected" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <FeedOverview feed={f} />
      </DetailTab>
      <DetailTab value="affected">
        <AffectedPanel kind="coolingfeed" id={f.id} name={f.name} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.coolingfeed" objectId={f.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.coolingfeed" objectId={f.id} />
      </DetailTab>

      <CoolingFeedDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function FeedOverview({ feed: f }: { feed: CoolingFeed }) {
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
    // A feed always runs from a source - the FK is non-nullable.
    { label: "Source", value: <SourceLink source={f.source} /> },
    { label: "Site", value: f.site ? <SiteCell site={f.site} /> : dash },
    { label: "Rack", value: f.rack ? <RackCell rack={f.rack} /> : dash },
    { label: "Status", value: <StatusBadge status={f.status} /> },
    { label: "Type", value: f.type_display || dash },
  ]

  const loop: KvRow[] = [
    {
      label: "Rated capacity",
      value: <span className="num">{fmtRating(f.rated_capacity_w)}</span>,
    },
    {
      label: "Load",
      value: (
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <CoolingFigure cooling={feedCooling(f.capacity)} bar />
          {f.capacity.redundant && f.rack && (
            <span className="text-[11px] text-muted-foreground">
              whole rack, if the primary fails
            </span>
          )}
        </span>
      ),
    },
    {
      label: "Flow",
      value: (
        <span className="num">{fmtDecimal(f.flow_rate_lpm, "L/min")}</span>
      ),
    },
    {
      label: "Supply temperature",
      value: <span className="num">{fmtDecimal(f.supply_temp_c, "°C")}</span>,
    },
    {
      label: "Return temperature",
      value: <span className="num">{fmtDecimal(f.return_temp_c, "°C")}</span>,
    },
    { label: "Connector", value: f.connector || dash },
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
    <div className="space-y-6">
      <div className="empty:hidden">
        <UpcomingMaintenancePanel objectType="coolingfeed" objectId={f.id} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Feed" rows={details} />
        <KvCard title="Loop" rows={loop} />
        <CustomFieldValues
          model="coolingfeed"
          values={f.custom_fields}
          layout="cards"
        />
        <KvCard title="Record" rows={record} />
        <KvCard title="Notes" rows={notes} />
      </div>
    </div>
  )
}
