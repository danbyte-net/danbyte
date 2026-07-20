import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, STATUSABLE_MODELS, type Status } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { IpStatusDeleteDialog } from "@/components/ip-status-delete-dialog"
import { EmbeddedIpTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/statuses/$id")({
  component: IpStatusDetail,
})

const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  STATUSABLE_MODELS.map((m) => [m.value, m.label])
)
const labelFor = (slug: string) => MODEL_LABELS[slug] ?? slug

function IpStatusDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["ip-status", id],
    queryFn: () => api<Status>(`/api/statuses/${id}/`),
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
  return <Body status={q.data} />
}

function Body({ status: s }: { status: Status }) {
  const [tab, setTab] = useUrlTab<"overview" | "ips" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const canEdit = canDo("ipstatus", "change")
  const canDelete = canDo("ipstatus", "delete")
  const [deleting, setDeleting] = useState<Status | null>(null)
  const goBack = useCallback(() => nav({ to: "/statuses" }), [nav])
  const flags = [
    s.is_available && "Available",
    s.requires_note && "Requires note",
  ].filter(Boolean) as string[]

  return (
    <DetailShell
      backTo="/statuses"
      backLabel="Statuses"
      title={s.name}
      presence={{ type: "ipstatus", id: s.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/statuses/$id/edit" params={{ id: s.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
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
        <>
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <ColorBadge name={s.name} color={s.color || undefined} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {flags.map((f) => (
                  <Badge key={f} variant="secondary">
                    {f}
                  </Badge>
                ))}
              </div>
              {s.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {s.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="IPs"
                value={<span className="num">{s.usage_count}</span>}
              />
            </dl>
          </section>

          <section className="shrink-0 border-b border-border px-6 py-4">
            <p className="text-sm text-muted-foreground">
              {s.usage_count > 0
                ? `${s.usage_count} IP${s.usage_count === 1 ? "" : "s"} currently carry this status.`
                : "No IPs use this status yet."}
            </p>
          </section>
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "ips", label: "IPs", count: s.usage_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <IpStatusOverview status={s} />
      </DetailTab>
      <DetailTab value="ips">
        <EmbeddedIpTable filter={{ status: s.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.ipstatus" objectId={s.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.ipstatus" objectId={s.id} />
      </DetailTab>

      <IpStatusDeleteDialog
        status={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function chipsValue(slugs: string[]): React.ReactNode {
  if (!slugs.length) return dash
  return (
    <span className="flex flex-wrap gap-1">
      {slugs.map((t) => (
        <span key={t} className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]">
          {labelFor(t)}
        </span>
      ))}
    </span>
  )
}

/** Status attributes that used to crowd the header, grouped into tables. */
function IpStatusOverview({ status: s }: { status: Status }) {
  const attributes: KvRow[] = [
    { label: "Weight", value: <span className="num">{s.weight}</span> },
    { label: "Available", value: s.is_available ? "Yes" : "No" },
    { label: "Requires note", value: s.requires_note ? "Yes" : "No" },
  ]
  const applies: KvRow[] = [
    { label: "Available to", value: chipsValue(s.available_to) },
    { label: "Default for", value: chipsValue(s.default_for) },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
      <KvCard title="Applies to" rows={applies} />
    </div>
  )
}
