import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type ServiceTemplate } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ServiceTemplateDeleteDialog } from "@/components/service-template-delete-dialog"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/service-templates/$id")({
  component: ServiceTemplateDetail,
})

function ServiceTemplateDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["service-template", id],
    queryFn: () => api<ServiceTemplate>(`/api/service-templates/${id}/`),
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
  return <Body template={q.data} />
}

function Body({ template: t }: { template: ServiceTemplate }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<ServiceTemplate | null>(null)
  const goBack = useCallback(() => nav({ to: "/service-templates" }), [nav])
  const { canDo } = useMe()

  return (
    <DetailShell
      backTo="/service-templates"
      backLabel="Service templates"
      title={t.name}
      presence={{ type: "servicetemplate", id: t.id }}
      actions={
        <>
          {canDo("servicetemplate", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/service-templates/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("servicetemplate", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(t)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold tracking-tight">
                {t.name}
              </span>
              <Badge variant="secondary">
                {t.protocol_display || t.protocol.toUpperCase()}
              </Badge>
            </div>
            <p className="mt-2 font-mono text-[13px] text-muted-foreground">
              {t.ports.length ? t.ports.join(", ") : "no ports"}
            </p>
            {t.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {t.description}
              </p>
            )}
          </div>
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
        <ServiceTemplateOverview template={t} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.servicetemplate" objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.servicetemplate" objectId={t.id} />
      </DetailTab>

      <ServiceTemplateDeleteDialog
        template={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Service-template attributes that used to crowd the header, grouped into a
 * labelled table. Name, protocol and ports stay up top. */
function ServiceTemplateOverview({
  template: t,
}: {
  template: ServiceTemplate
}) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && t.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{t.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-xs">{t.slug}</span>,
      copy: t.slug,
    },
    {
      label: "In use",
      value: <span className="num">{t.service_count ?? 0}</span>,
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
    </div>
  )
}
