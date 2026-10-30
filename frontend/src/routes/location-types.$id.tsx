import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Location, LocationType } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable } from "@/components/data-table"
import { DynamicIcon } from "@/components/dynamic-icon"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { buildLocationColumns } from "@/components/columns/location-columns"
import { LocationTypeDeleteDialog } from "@/components/location-type-delete-dialog"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/location-types/$id")({
  component: LocationTypeDetail,
})

function LocationTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["location-type", id],
    queryFn: () => api<LocationType>(`/api/location-types/${id}/`),
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

function Body({ type: t }: { type: LocationType }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "locations" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<LocationType | null>(null)
  const goBack = useCallback(() => nav({ to: "/location-types" }), [nav])

  return (
    <DetailShell
      backTo="/location-types"
      backLabel="Location types"
      title={t.name}
      presence={{ type: "locationtype", id: t.id }}
      actions={
        <>
          {canDo("locationtype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/location-types/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("locationtype", "delete") && (
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
        { value: "locations", label: "Locations", count: t.location_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <Overview type={t} />
      </DetailTab>
      <DetailTab value="locations">
        <TypeLocations typeId={t.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.locationtype" objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.locationtype" objectId={t.id} />
      </DetailTab>

      <LocationTypeDeleteDialog
        locationType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function Overview({ type: t }: { type: LocationType }) {
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
      label: "Locations",
      value: <span className="num">{t.location_count}</span>,
    },
    { label: "Created", value: <TimeCell iso={t.created_at} /> },
    { label: "Updated", value: <TimeCell iso={t.updated_at} /> },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Location type" rows={rows} />
    </div>
  )
}

function TypeLocations({ typeId }: { typeId: string }) {
  const q = useQuery({
    queryKey: ["locations", "by-type", typeId],
    queryFn: () =>
      apiAll<Location>(
        `/api/locations/?${new URLSearchParams({ location_type: typeId }).toString()}`
      ),
  })
  const columns = useMemo<ColumnDef<Location>[]>(
    () => buildLocationColumns<Location>({ omit: ["type"] }),
    []
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return <EmptyState title="No locations of this type." />
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="location-type-locations"
      flexColumn="name"
      embedded
      searchable
      searchPlaceholder="Search locations…"
    />
  )
}
