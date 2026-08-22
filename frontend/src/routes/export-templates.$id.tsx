import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Download, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ExportTemplate } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { downloadBlob } from "@/lib/table-export"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ExportTemplateDeleteDialog } from "@/components/export-template-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

const OBJECT_TYPE = "api.exporttemplate"

// An export template has no reverse relations: nothing in the model points back
// at it, and a render is produced on demand rather than stored. So the honest
// page is Overview + Journal + History - with the template body treated as the
// content, not as one more attribute row.
type Tab = "overview" | "journal" | "history"
const TABS: readonly Tab[] = ["overview", "journal", "history"]

export const Route = createFileRoute("/export-templates/$id")({
  component: ExportTemplateDetail,
})

function ExportTemplateDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["export-template", id],
    queryFn: () => api<ExportTemplate>(`/api/export-templates/${id}/`),
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

/** Render + download the template's output. Fetches the file first so a render
 * error surfaces as a toast rather than downloading an error page - the same
 * treatment the list page's row button gives it. */
function RenderButton({ template }: { template: ExportTemplate }) {
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/export-templates/${template.id}/render/`, {
        credentials: "include",
      })
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          detail = (await res.json()).detail ?? detail
        } catch {
          /* keep the status line */
        }
        throw new Error(detail)
      }
      const text = await res.text()
      const ext = (template.file_extension || "txt").replace(/^\./, "")
      downloadBlob(
        `${template.name}.${ext}`,
        template.mime_type || "text/plain",
        text
      )
    },
    onError: (err) => toast.error(`Render failed: ${err.message}`),
  })
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      <Download className="h-3.5 w-3.5" />
      {m.isPending ? "Rendering…" : "Render"}
    </Button>
  )
}

function Body({ template: t }: { template: ExportTemplate }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<ExportTemplate | null>(null)
  const goBack = useCallback(() => nav({ to: "/export-templates" }), [nav])
  const lines = t.template_code ? t.template_code.split("\n").length : 0

  return (
    <DetailShell
      backTo="/export-templates"
      backLabel="Export templates"
      title={t.name}
      presence={{ type: "exporttemplate", id: t.id }}
      actions={
        <>
          <RenderButton template={t} />
          {canDo("exporttemplate", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/export-templates/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("exporttemplate", "delete") && (
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
        <DetailHero
          title={t.name}
          badges={
            <Badge variant="secondary" className="text-[10px]">
              {t.object_type_label}
            </Badge>
          }
          subtitle={
            <span className="font-mono">
              .{t.file_extension.replace(/^\./, "")} · {t.mime_type}
            </span>
          }
          description={t.description}
          stats={
            <>
              <DetailStat
                label="Lines"
                value={<span className="num">{lines}</span>}
              />
              <DetailStat
                label="Delivery"
                value={t.as_attachment ? "Attachment" : "Inline"}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <TemplateOverview template={t} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={t.id} />
      </DetailTab>

      <ExportTemplateDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function TemplateOverview({ template: t }: { template: ExportTemplate }) {
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
    { label: "Name", value: t.name, copy: t.name },
    {
      label: "Object type",
      value: (
        <span>
          {t.object_type_label}
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {t.object_type}
          </span>
        </span>
      ),
      copy: t.object_type,
    },
    {
      label: "Description",
      value: t.description ? (
        <span className="whitespace-pre-wrap">{t.description}</span>
      ) : (
        dash
      ),
    },
  ]

  const output: KvRow[] = [
    {
      label: "File extension",
      value: (
        <span className="font-mono text-[13px]">
          .{t.file_extension.replace(/^\./, "")}
        </span>
      ),
    },
    {
      label: "MIME type",
      value: <span className="font-mono text-[13px]">{t.mime_type}</span>,
    },
    {
      label: "Delivery",
      value: t.as_attachment
        ? "Downloaded as an attachment"
        : "Rendered inline in the browser",
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={t.created_at} /> },
    { label: "Updated", value: <TimeCell iso={t.updated_at} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Export template" rows={details} />
        <KvCard title="Output" rows={output} />
        <KvCard title="Record" rows={record} />
      </div>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Template
        </h2>
        {t.template_code ? (
          // Same treatment as a config context's data blob: scrolls in its own
          // box, because a Jinja template can be long *and* wide and neither
          // may push the page into a horizontal scroll.
          <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
            {t.template_code}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            This template has no body - rendering it produces an empty file.
          </p>
        )}
      </section>
    </div>
  )
}
