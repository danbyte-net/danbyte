import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type CustomField } from "@/lib/api"
import { fieldTypeLabel, modelLabel } from "@/lib/custom-fields"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { CustomFieldDeleteDialog } from "@/components/custom-field-delete-dialog"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/custom-fields/$id")({
  component: CustomFieldDetail,
})

function CustomFieldDetail() {
  const { id } = Route.useParams()
  const cf = useQuery({
    queryKey: ["custom-field", id],
    queryFn: () => api<CustomField>(`/api/custom-fields/${id}/`),
  })
  if (cf.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (cf.isError)
    return (
      <div className="p-6">
        <QueryError error={cf.error} />
      </div>
    )
  if (!cf.data) return null
  return <CustomFieldDetailBody field={cf.data} />
}

function CustomFieldDetailBody({ field: f }: { field: CustomField }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const canEdit = canDo("customfield", "change")
  const canDelete = canDo("customfield", "delete")
  const [deleting, setDeleting] = useState<CustomField | null>(null)
  const goBack = useCallback(() => nav({ to: "/custom-fields" }), [nav])

  return (
    <DetailShell
      backTo="/custom-fields"
      backLabel="Custom fields"
      title={<span className="font-mono">{f.key}</span>}
      presence={{ type: "customfield", id: f.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/custom-fields/$id/edit" params={{ id: f.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
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
        <section className="flex shrink-0 flex-wrap items-start gap-x-6 gap-y-2 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {f.label}
              </h1>
              <Badge variant="secondary">{fieldTypeLabel(f.type)}</Badge>
              {f.required && <Badge variant="secondary">Required</Badge>}
            </div>
            <p className="mt-1 font-mono text-[13px] text-muted-foreground">
              {f.key}
            </p>
            {f.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {f.description}
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
        <dl className="max-w-2xl divide-y divide-border text-sm">
          <Row label="Applies to">
            {f.applies_to.length ? (
              <div className="flex flex-wrap gap-1">
                {f.applies_to.map((m) => (
                  <span
                    key={m}
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
                  >
                    {modelLabel(m)}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">No objects yet</span>
            )}
          </Row>
          {f.choices.length > 0 && (
            <Row label="Choices">
              <div className="flex flex-wrap gap-1">
                {f.choices.map((c) => (
                  <span
                    key={c}
                    className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </Row>
          )}
          <Row label="Default">
            {f.default ? (
              <span className="font-mono text-[13px]">{f.default}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Required">{f.required ? "Yes" : "No"}</Row>
          <Row label="Weight">
            <span className="num">{f.weight}</span>
          </Row>
        </dl>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="customization.customfield" objectId={f.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel
          objectType="customization.customfield"
          objectId={f.id}
        />
      </DetailTab>

      <CustomFieldDeleteDialog
        field={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-3 gap-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{children}</dd>
    </div>
  )
}
