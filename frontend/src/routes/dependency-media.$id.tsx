import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { DependencyMedium } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { DynamicIcon } from "@/components/dynamic-icon"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { LocalityBadge } from "@/components/locality-badge"
import { QueryError } from "@/components/query-error"
import {
  DependencyMediumBadge,
  lineStyleLabel,
} from "@/components/dependency-medium-badge"
import { DependencyMediumDeleteDialog } from "@/components/dependency-medium-delete-dialog"
import { DeviceDependencyTable } from "@/components/device-dependencies/dependency-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/dependency-media/$id")({
  component: DependencyMediumDetail,
})

function DependencyMediumDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["dependency-medium", id],
    queryFn: () => api<DependencyMedium>(`/api/dependency-media/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body medium={q.data} />
}

type Tab = "overview" | "dependencies" | "journal" | "history"

function Body({ medium: m }: { medium: DependencyMedium }) {
  const [tab, setTab] = useUrlTab<Tab>("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<DependencyMedium | null>(null)
  const goBack = useCallback(() => nav({ to: "/dependency-media" }), [nav])
  const canChange =
    canDo("dependencymedium", "change") && m.permissions?.change !== false
  const canDelete =
    canDo("dependencymedium", "delete") && m.permissions?.delete !== false

  return (
    <DetailShell
      backTo="/dependency-media"
      backLabel="Dependency media"
      title={m.name}
      presence={{ type: "dependencymedium", id: m.id }}
      actions={
        <>
          {canChange && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/dependency-media/$id/edit" params={{ id: m.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(m)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={<DependencyMediumBadge medium={m} />}
          description={m.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        ...(canDo("devicedependency", "view")
          ? [
              {
                value: "dependencies",
                label: "Dependencies",
                count: m.usage_count || undefined,
              },
            ]
          : []),
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <Overview medium={m} />
      </DetailTab>
      <DetailTab value="dependencies">
        <DeviceDependencyTable filter={{ medium: m.id }} omit={["medium"]} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.dependencymedium" objectId={m.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.dependencymedium" objectId={m.id} />
      </DetailTab>

      <DependencyMediumDeleteDialog
        medium={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function Overview({ medium: m }: { medium: DependencyMedium }) {
  const rows: KvRow[] = [
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{m.slug}</span>,
      copy: m.slug,
    },
    {
      label: "Color",
      value: m.color ? (
        <ColorBadge name={m.color} color={m.color} className="font-mono" />
      ) : (
        dash
      ),
    },
    {
      label: "Icon",
      value: m.icon ? (
        <span className="inline-flex items-center gap-1.5">
          <DynamicIcon name={m.icon} className="h-3.5 w-3.5" />
          <span className="font-mono text-[13px]">{m.icon}</span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Line", value: lineStyleLabel(m.line_style) },
    { label: "Weight", value: <span className="num">{m.weight}</span> },
    { label: "Scope", value: <LocalityBadge owningSite={m.owning_site} /> },
    {
      label: "Dependencies",
      value: <span className="num">{m.usage_count}</span>,
    },
    { label: "Created", value: <TimeCell iso={m.created_at} /> },
    { label: "Updated", value: <TimeCell iso={m.updated_at} /> },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Dependency medium" rows={rows} />
    </div>
  )
}
