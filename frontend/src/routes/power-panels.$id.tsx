import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { PowerPanel } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { TagList } from "@/components/cells/tag-list"
import { SiteCell } from "@/components/cells/site-cell"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { PowerPanelDeleteDialog } from "@/components/power-panel-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { EmbeddedPowerFeedTable } from "@/components/embedded-tables"

export const Route = createFileRoute("/power-panels/$id")({
  component: PowerPanelDetail,
})

function PowerPanelDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["power-panel", id],
    queryFn: () => api<PowerPanel>(`/api/power-panels/${id}/`),
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
  return <Body panel={q.data} />
}

function Body({ panel: p }: { panel: PowerPanel }) {
  const [tab, setTab] = useUrlTab<"overview" | "feeds" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<PowerPanel | null>(null)
  const goBack = useCallback(() => nav({ to: "/power-panels" }), [nav])

  return (
    <DetailShell
      backTo="/power-panels"
      backLabel="Power panels"
      title={p.name}
      presence={{ type: "powerpanel", id: p.id }}
      actions={
        <>
          {canDo("powerpanel", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/power-panels/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("powerpanel", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(p)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <DetailHero
            title={p.name}
            subtitle={p.site && <SiteCell site={p.site} />}
            tags={p.tags.length > 0 && <TagList tags={p.tags} />}
            statCols={1}
            stats={
              <DetailStat
                label="Feeds"
                value={<span className="num">{p.feed_count}</span>}
              />
            }
          />
          <CustomFieldValues model="powerpanel" values={p.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "feeds", label: "Feeds", count: p.feed_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <PanelOverview panel={p} />
      </DetailTab>
      <DetailTab value="feeds">
        <EmbeddedPowerFeedTable
          filter={{ power_panel: p.id }}
          omitPanel
          emptyText="No feeds draw from this panel yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.powerpanel" objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.powerpanel" objectId={p.id} />
      </DetailTab>

      <PowerPanelDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function PanelOverview({ panel: p }: { panel: PowerPanel }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && p.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{p.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: p.name, copy: p.name },
    { label: "Site", value: p.site ? <SiteCell site={p.site} /> : dash },
    { label: "Feeds", value: <span className="num">{p.feed_count}</span> },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={p.created_at} /> },
    { label: "Updated", value: <TimeCell iso={p.updated_at} /> },
  ]

  const notes: KvRow[] = [
    {
      label: "Comments",
      value: p.comments ? (
        <span className="whitespace-pre-wrap">{p.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Panel" rows={details} />
      <KvCard title="Record" rows={record} />
      <KvCard title="Notes" rows={notes} />
    </div>
  )
}
