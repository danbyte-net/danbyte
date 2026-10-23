import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { CoolingSource } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { TagList } from "@/components/cells/tag-list"
import { SiteCell } from "@/components/cells/site-cell"
import { LocationCell } from "@/components/cells/location-cell"
import { DeviceCell } from "@/components/cells/device-cell"
import { CoolingFigure } from "@/components/cells/power-figure"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { StatusBadge } from "@/components/status-badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { CoolingSourceDeleteDialog } from "@/components/cooling-source-delete-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { EmbeddedCoolingFeedTable } from "@/components/embedded-tables"
import { AffectedPanel } from "@/components/feed-affected-panel"
import { UpcomingMaintenancePanel } from "@/components/monitoring/upcoming-maintenance"
import {
  fmtRating,
  sourceCooling,
} from "@/components/columns/cooling-source-columns"

export const Route = createFileRoute("/cooling-sources/$id")({
  component: CoolingSourceDetail,
})

function CoolingSourceDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["cooling-source", id],
    queryFn: () => api<CoolingSource>(`/api/cooling-sources/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body source={q.data} />
}

function Body({ source: s }: { source: CoolingSource }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "feeds" | "affected" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<CoolingSource | null>(null)
  const goBack = useCallback(() => nav({ to: "/cooling-sources" }), [nav])

  return (
    <DetailShell
      backTo="/cooling-sources"
      backLabel="Cooling sources"
      title={s.name}
      presence={{ type: "coolingsource", id: s.id }}
      actions={
        <>
          {canDo("coolingsource", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/cooling-sources/$id/edit" params={{ id: s.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("coolingsource", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(s)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={s.name}
          badges={<StatusBadge status={s.status} />}
          subtitle={s.site && <SiteCell site={s.site} />}
          tags={
            s.tags.length > 0 && (
              <TagList tags={s.tags} listTo="/cooling-sources" />
            )
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "feeds", label: "Feeds", count: s.feed_count },
        { value: "affected", label: "Affected" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <SourceOverview source={s} />
      </DetailTab>
      <DetailTab value="feeds">
        <EmbeddedCoolingFeedTable
          filter={{ source: s.id }}
          omitSource
          emptyText="No feeds run from this source yet."
        />
      </DetailTab>
      <DetailTab value="affected">
        <AffectedPanel kind="coolingsource" id={s.id} name={s.name} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.coolingsource" objectId={s.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.coolingsource" objectId={s.id} />
      </DetailTab>

      <CoolingSourceDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function SourceOverview({ source: s }: { source: CoolingSource }) {
  const { humanIds } = useMe()

  const unit: KvRow[] = [
    ...(humanIds && s.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{s.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: s.name, copy: s.name },
    { label: "Type", value: s.type_display || dash },
    { label: "Fluid", value: s.fluid_display || dash },
    { label: "Status", value: <StatusBadge status={s.status} /> },
    { label: "Site", value: s.site ? <SiteCell site={s.site} /> : dash },
    {
      label: "Location",
      value: s.location ? <LocationCell location={s.location} /> : dash,
    },
    {
      label: "Device",
      value: s.device ? <DeviceCell device={s.device} /> : dash,
    },
    { label: "Redundancy group", value: s.redundancy_group || dash },
  ]

  const capacity: KvRow[] = [
    {
      label: "Rated capacity",
      value: <span className="num">{fmtRating(s.rated_capacity_w)}</span>,
    },
    {
      label: "Load",
      value: <CoolingFigure cooling={sourceCooling(s.capacity)} bar />,
    },
    {
      label: "Racks served",
      value: <span className="num">{s.capacity.racks}</span>,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={s.created_at} /> },
    { label: "Updated", value: <TimeCell iso={s.updated_at} /> },
  ]

  const notes: KvRow[] = [
    {
      label: "Comments",
      value: s.comments ? (
        <span className="whitespace-pre-wrap">{s.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <div className="empty:hidden">
        <UpcomingMaintenancePanel objectType="coolingsource" objectId={s.id} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Unit" rows={unit} />
        <KvCard title="Capacity" rows={capacity} />
        <CustomFieldValues
          model="coolingsource"
          values={s.custom_fields}
          layout="cards"
        />
        <KvCard title="Record" rows={record} />
        <KvCard title="Notes" rows={notes} />
      </div>
    </div>
  )
}
