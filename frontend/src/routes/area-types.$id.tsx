import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { AreaType } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { DynamicIcon } from "@/components/dynamic-icon"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { AreaTypeDeleteDialog } from "@/components/area-type-delete-dialog"
import { AreaSwatch } from "@/components/floorplan/area-legend"
import { AREA_PATTERNS } from "@/components/floorplan/shapes"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/area-types/$id")({
  component: AreaTypeDetail,
})

function AreaTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["area-type", id],
    queryFn: () => api<AreaType>(`/api/area-types/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body type={q.data} />
}

function Body({ type: t }: { type: AreaType }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<AreaType | null>(null)
  const goBack = useCallback(() => nav({ to: "/area-types" }), [nav])

  return (
    <DetailShell
      backTo="/area-types"
      backLabel="Area types"
      title={t.name}
      presence={{ type: "areatype", id: t.id }}
      actions={
        <>
          {canDo("areatype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/area-types/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("areatype", "delete") && (
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
          title={<ColorBadge name={t.name} color={t.color || undefined} />}
          description={t.description}
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
        <Overview type={t} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.areatype" objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.areatype" objectId={t.id} />
      </DetailTab>

      <AreaTypeDeleteDialog
        areaType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function Overview({ type: t }: { type: AreaType }) {
  const { humanIds } = useMe()
  const rows: KvRow[] = [
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
      value: <span className="font-mono text-[13px]">{t.slug}</span>,
      copy: t.slug,
    },
    {
      label: "Color",
      value: t.color ? (
        <ColorBadge name={t.color} color={t.color} className="font-mono" />
      ) : (
        dash
      ),
    },
    {
      label: "Fill pattern",
      value: (
        <span className="inline-flex items-center gap-1.5">
          <AreaSwatch type={t} />
          {AREA_PATTERNS.find((p) => p.value === t.pattern)?.label ?? t.pattern}
        </span>
      ),
    },
    {
      label: "Icon",
      value: t.icon ? (
        <span className="inline-flex items-center gap-1.5">
          <DynamicIcon name={t.icon} className="h-3.5 w-3.5" />
          <span className="font-mono text-[13px]">{t.icon}</span>
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "Areas",
      value: <span className="num">{t.area_count}</span>,
    },
    { label: "Created", value: <TimeCell iso={t.created_at} /> },
    { label: "Updated", value: <TimeCell iso={t.updated_at} /> },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Area type" rows={rows} />
    </div>
  )
}
