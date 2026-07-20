import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type ASN } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { Button } from "@/components/ui/button"
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
  const [tab, setTab] = useUrlTab<"journal" | "history">("journal")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<ASN | null>(null)
  const goBack = useCallback(() => nav({ to: "/asns" }), [nav])
  const { canDo, humanIds } = useMe()

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
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-2xl font-semibold tracking-tight">
                AS{a.asn}
              </span>
              {humanIds && a.numid != null && (
                <span className="num font-mono text-sm text-muted-foreground">
                  #{a.numid}
                </span>
              )}
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
            {a.sites.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                  Sites
                </span>
                {a.sites.map((s) => (
                  <Link
                    key={s.id}
                    to="/sites/$id"
                    params={{ id: s.id }}
                    className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted/80"
                  >
                    {s.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      }
      tabs={[
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
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
