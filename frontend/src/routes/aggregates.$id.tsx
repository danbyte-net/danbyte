import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type Aggregate } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { Button } from "@/components/ui/button"
import { KvCard, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { UtilCell } from "@/components/cells/util-cell"
import { AggregateDeleteDialog } from "@/components/aggregate-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/aggregates/$id")({
  component: AggregateDetail,
})

function AggregateDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["aggregate", id],
    queryFn: () => api<Aggregate>(`/api/aggregates/${id}/`),
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
  return <Body aggregate={q.data} />
}

function Body({ aggregate: a }: { aggregate: Aggregate }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Aggregate | null>(null)
  const goBack = useCallback(() => nav({ to: "/aggregates" }), [nav])
  const { canDo } = useMe()

  return (
    <DetailShell
      backTo="/aggregates"
      backLabel="Aggregates"
      title={<span className="font-mono">{a.prefix}</span>}
      presence={{ type: "aggregate", id: a.id }}
      actions={
        <>
          {canDo("aggregate", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/aggregates/$id/edit" params={{ id: a.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("aggregate", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(a)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-2xl font-semibold tracking-tight">
                {a.prefix}
              </span>
              {a.rir && (
                <Link
                  to="/rirs/$id"
                  params={{ id: a.rir.id }}
                  className="text-sm text-primary hover:underline"
                >
                  {a.rir.name}
                </Link>
              )}
            </div>
            {a.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={a.tags} />
              </div>
            )}
            {a.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {a.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-1 gap-x-8 gap-y-3 text-[13px]">
            <DetailStat
              label="Utilisation"
              value={<UtilCell pct={a.utilisation_pct} />}
            />
          </dl>
        </section>
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
        <AggregateOverview aggregate={a} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.aggregate" objectId={a.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.aggregate" objectId={a.id} />
      </DetailTab>

      <AggregateDeleteDialog
        aggregate={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Aggregate attributes, moved out of the page header. */
function AggregateOverview({ aggregate: a }: { aggregate: Aggregate }) {
  const { humanIds } = useMe()
  const details: KvRow[] = [
    ...(humanIds && a.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{a.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Family",
      value: <span className="num">{a.family ? `IPv${a.family}` : "—"}</span>,
    },
    {
      label: "Date added",
      value: <span className="num text-xs">{a.date_added ?? "—"}</span>,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
    </div>
  )
}
