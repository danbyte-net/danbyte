import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type ASN } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { Button } from "@/components/ui/button"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { AsnDeleteDialog } from "@/components/asn-delete-dialog"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/asns/$id")({ component: AsnDetail })

function AsnDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["asn", id],
    queryFn: () => api<ASN>(`/api/asns/${id}/`),
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
  return <Body asn={q.data} />
}

function Body({ asn: a }: { asn: ASN }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<ASN | null>(null)
  const goBack = useCallback(() => nav({ to: "/asns" }), [nav])
  const { canDo } = useMe()

  return (
    <DetailShell
      backTo="/asns"
      backLabel="ASNs"
      title={<span className="font-mono">AS{a.asn}</span>}
      presence={{ type: "asn", id: a.id }}
      actions={
        <>
          {canDo("asn", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/asns/$id/edit" params={{ id: a.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("asn", "delete") && (
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
        <DetailHero
          title={`AS${a.asn}`}
          mono
          tags={a.tags.length > 0 && <TagList tags={a.tags} />}
          description={a.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <AsnOverview asn={a} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.asn" objectId={a.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.asn" objectId={a.id} />
      </DetailTab>

      <AsnDeleteDialog
        asn={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** ASN attributes, moved out of the page header. */
function AsnOverview({ asn: a }: { asn: ASN }) {
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
      label: "AS number",
      value: <span className="num font-mono text-[13px]">{a.asn}</span>,
      copy: String(a.asn),
    },
    {
      label: "RIR",
      value: a.rir ? (
        <Link to="/rirs/$id" params={{ id: a.rir.id }} className="link">
          {a.rir.name}
        </Link>
      ) : (
        dash
      ),
    },
  ]

  const assignment: KvRow[] = [
    {
      label: "Sites",
      value: a.sites.length ? (
        <span className="flex flex-wrap gap-1">
          {a.sites.map((s) => (
            <Link
              key={s.id}
              to="/sites/$id"
              params={{ id: s.id }}
              className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] hover:bg-muted/80"
            >
              {s.name}
            </Link>
          ))}
        </span>
      ) : (
        dash
      ),
    },
    { label: "Created", value: <TimeCell iso={a.created_at} /> },
    { label: "Updated", value: <TimeCell iso={a.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="ASN" rows={details} />
      <KvCard title="Assignment" rows={assignment} />
    </div>
  )
}
