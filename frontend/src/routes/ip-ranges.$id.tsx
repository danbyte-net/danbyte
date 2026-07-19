import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type IPRange, type IPRangeAvailable } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { Button } from "@/components/ui/button"
import { KvCard, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { IpRangeDeleteDialog } from "@/components/ip-range-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/ip-ranges/$id")({
  component: IpRangeDetail,
})

function IpRangeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["ip-range", id],
    queryFn: () => api<IPRange>(`/api/ip-ranges/${id}/`),
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
  return <Body range={q.data} />
}

function Body({ range: r }: { range: IPRange }) {
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<IPRange | null>(null)
  const [tab, setTab] = useState<
    "overview" | "available" | "journal" | "history"
  >("overview")
  const goBack = useCallback(() => nav({ to: "/ip-ranges" }), [nav])
  const { canDo } = useMe()

  return (
    <DetailShell
      backTo="/ip-ranges"
      backLabel="IP ranges"
      title={
        <span className="font-mono">
          {r.start_address}–{r.end_address}
        </span>
      }
      presence={{ type: "iprange", id: r.id }}
      actions={
        <>
          {canDo("iprange", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/ip-ranges/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("iprange", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
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
              <span className="font-mono text-xl font-semibold tracking-tight">
                {r.start_address} – {r.end_address}
              </span>
              <StatusBadge status={r.status} />
              {r.role && (
                <ColorBadge
                  name={r.role.name}
                  color={r.role.color || undefined}
                />
              )}
            </div>
            {r.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={r.tags} />
              </div>
            )}
            {r.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {r.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            <DetailStat
              label="Size"
              value={
                <span className="num">
                  {r.size != null ? r.size.toLocaleString() : "—"}
                </span>
              }
            />
            <DetailStat
              label="Family"
              value={
                <span className="num">{r.family ? `IPv${r.family}` : "—"}</span>
              }
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "available", label: "Available" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <IpRangeOverview range={r} />
      </DetailTab>
      <DetailTab value="available">
        <AvailablePanel rangeId={r.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.iprange" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.iprange" objectId={r.id} />
      </DetailTab>

      <IpRangeDeleteDialog
        range={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function AvailablePanel({ rangeId }: { rangeId: string }) {
  const q = useQuery({
    queryKey: ["ip-range-available", rangeId],
    queryFn: () =>
      api<IPRangeAvailable>(`/api/ip-ranges/${rangeId}/available/`),
  })

  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Available addresses
      </h2>
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-[13px]">
            <span className="text-muted-foreground">
              <span className="num font-medium text-foreground">
                {q.data.available.toLocaleString()}
              </span>{" "}
              free
            </span>
            <span className="text-muted-foreground">
              <span className="num font-medium text-foreground">
                {q.data.used.toLocaleString()}
              </span>{" "}
              used
            </span>
            <span className="text-muted-foreground">
              <span className="num font-medium text-foreground">
                {q.data.size.toLocaleString()}
              </span>{" "}
              total
            </span>
          </div>
          {q.data.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No free addresses in this range.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {q.data.results.map((addr) => (
                <span
                  key={addr}
                  className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                >
                  {addr}
                </span>
              ))}
              {q.data.truncated && (
                <span className="px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  …more
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** IP-range attributes, moved out of the page header. */
function IpRangeOverview({ range: r }: { range: IPRange }) {
  const { humanIds } = useMe()
  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "VRF",
      value: <span className="text-xs">{r.vrf ? r.vrf.name : "Global"}</span>,
    },
    {
      label: "Prefix",
      value: r.prefix ? (
        <Link
          to="/prefixes/$id"
          params={{ id: r.prefix.id }}
          className="font-mono text-[13px] text-primary hover:underline"
        >
          {r.prefix.cidr}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
    </div>
  )
}
