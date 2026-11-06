import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { SensitivityLabel } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { DynamicIcon } from "@/components/dynamic-icon"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SensitivityBadge } from "@/components/sensitivity-badge"
import { SensitivityLabelDeleteDialog } from "@/components/sensitivity-label-delete-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/sensitivity-labels/$id")({
  component: SensitivityLabelDetail,
})

function SensitivityLabelDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["sensitivity-label", id],
    queryFn: () => api<SensitivityLabel>(`/api/sensitivity-labels/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body label={q.data} />
}

function Body({ label: l }: { label: SensitivityLabel }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<SensitivityLabel | null>(null)
  const goBack = useCallback(() => nav({ to: "/sensitivity-labels" }), [nav])
  const canChange =
    canDo("sensitivitylabel", "change") && l.permissions?.change !== false
  const canDelete =
    canDo("sensitivitylabel", "delete") && l.permissions?.delete !== false

  return (
    <DetailShell
      backTo="/sensitivity-labels"
      backLabel="Sensitivity labels"
      title={l.name}
      presence={{ type: "sensitivitylabel", id: l.id }}
      actions={
        <>
          {canChange && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/sensitivity-labels/$id/edit" params={{ id: l.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(l)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={<SensitivityBadge label={l} />}
          description={l.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <Overview label={l} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.sensitivitylabel" objectId={l.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.sensitivitylabel" objectId={l.id} />
      </DetailTab>

      <SensitivityLabelDeleteDialog
        label={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function Overview({ label: l }: { label: SensitivityLabel }) {
  const { humanIds } = useMe()
  const rows: KvRow[] = [
    ...(humanIds && l.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{l.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{l.slug}</span>,
      copy: l.slug,
    },
    {
      label: "Color",
      value: l.color ? (
        <ColorBadge name={l.color} color={l.color} className="font-mono" />
      ) : (
        dash
      ),
    },
    {
      label: "Icon",
      value: l.icon ? (
        <span className="inline-flex items-center gap-1.5">
          <DynamicIcon name={l.icon} className="h-3.5 w-3.5" />
          <span className="font-mono text-[13px]">{l.icon}</span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Weight", value: <span className="num">{l.weight}</span> },
    {
      label: "Default for reports",
      value: l.is_default ? <Badge variant="secondary">Default</Badge> : dash,
    },
    { label: "Created", value: <TimeCell iso={l.created_at} /> },
    { label: "Updated", value: <TimeCell iso={l.updated_at} /> },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Sensitivity label" rows={rows} />
    </div>
  )
}
