import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type {
  FloorPlanTile,
  FloorTileType,
  Paginated,
  SiteMarker,
} from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { SimpleTable } from "@/components/ui/simple-table"
import { DynamicIcon } from "@/components/dynamic-icon"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { buildFloorTileColumns } from "@/components/columns/floor-tile-columns"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { FloorTileTypeDeleteDialog } from "@/routes/floor-tile-types.index"

export const Route = createFileRoute("/floor-tile-types/$id")({
  component: FloorTileTypeDetail,
})

function FloorTileTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["floor-tile-type", id],
    queryFn: () => api<FloorTileType>(`/api/floor-tile-types/${id}/`),
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
  return <Body type={q.data} />
}

function Body({ type: t }: { type: FloorTileType }) {
  const [tab, setTab] = useUrlTab<"overview" | "tiles" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<FloorTileType | null>(null)
  const goBack = useCallback(() => nav({ to: "/floor-tile-types" }), [nav])

  const flags = [
    t.is_zone && "Background zone",
    t.has_fov && "Field of view",
    t.perforated && "Perforated",
  ].filter(Boolean) as string[]

  return (
    <DetailShell
      backTo="/floor-tile-types"
      backLabel="Floor tiles"
      title={t.name}
      presence={{ type: "floortiletype", id: t.id }}
      actions={
        <>
          {canDo("floortiletype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/floor-tile-types/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("floortiletype", "delete") && (
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
          badges={flags.map((f) => (
            <Badge key={f} variant="secondary">
              {f}
            </Badge>
          ))}
          subtitle={
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border"
                style={
                  t.color ? { backgroundColor: `${t.color}33` } : undefined
                }
              >
                <DynamicIcon name={t.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="font-mono">{t.slug}</span>
            </span>
          }
          description={t.description}
          stats={
            <>
              <DetailStat
                label="Placed"
                value={<span className="num">{t.tile_count}</span>}
              />
              <DetailStat
                label="Default size"
                value={
                  <span className="num">
                    {t.default_width} × {t.default_height}
                  </span>
                }
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "tiles", label: "Placed", count: t.tile_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <TypeOverview type={t} />
      </DetailTab>
      <DetailTab value="tiles">
        <PlacedTilesTable typeId={t.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.floortiletype" objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.floortiletype" objectId={t.id} />
      </DetailTab>

      <FloorTileTypeDeleteDialog
        tileType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function TypeOverview({ type: t }: { type: FloorTileType }) {
  const { humanIds } = useMe()

  const appearance: KvRow[] = [
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
      label: "Slug",
      value: <span className="font-mono text-[13px]">{t.slug}</span>,
      copy: t.slug,
    },
    {
      label: "Color",
      value: t.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: t.color }}
          />
          <span className="font-mono text-[13px]">{t.color}</span>
        </span>
      ) : (
        dash
      ),
      copy: t.color || undefined,
    },
    {
      label: "Icon",
      value: t.icon ? (
        <span className="inline-flex items-center gap-1.5">
          <DynamicIcon name={t.icon} className="h-3.5 w-3.5" />
          {mono(t.icon)}
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "Default size",
      value: (
        <span className="num">
          {t.default_width} × {t.default_height}
        </span>
      ),
    },
  ]

  // A tile's *behaviour* comes from what it links to; these three ticks only
  // change how tiles of this type are drawn.
  const behaviour: KvRow[] = [
    { label: "Background zone", value: t.is_zone ? "Yes" : "No" },
    { label: "Field of view", value: t.has_fov ? "Yes" : "No" },
    { label: "Perforated (3D)", value: t.perforated ? "Yes" : "No" },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={t.created_at} /> },
    { label: "Updated", value: <TimeCell iso={t.updated_at} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Tile type" rows={appearance} />
        <KvCard title="Rendering" rows={behaviour} />
        <KvCard title="Record" rows={record} />
      </div>
      <SiteMarkersSection typeId={t.id} />
    </div>
  )
}

/**
 * Markers on the geographic site map that reuse this tile type as their
 * vocabulary. Deliberately a short section on Overview rather than a tab: a
 * type is used by a handful of markers at most, while its placed tiles run to
 * hundreds - a tab here would be a mostly-empty pane. Both relations are
 * `PROTECT`, so both block a delete and both belong on the page.
 */
function SiteMarkersSection({ typeId }: { typeId: string }) {
  const q = useQuery({
    queryKey: ["site-markers", "by-tile-type", typeId],
    queryFn: () =>
      api<Paginated<SiteMarker>>(
        `/api/site-markers/?tile_type=${typeId}&page_size=500`
      ),
  })
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  const rows = q.data?.results ?? []

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Site markers
      </h2>
      <SimpleTable<SiteMarker>
        data={rows}
        getRowKey={(m) => m.id}
        empty="No markers on the site map use this type."
        columns={[
          {
            id: "label",
            header: "Label",
            flex: true,
            cell: (m) => (
              <Link to="/site-map" className="link font-medium">
                {m.label || "Unlabelled marker"}
              </Link>
            ),
          },
          {
            id: "coords",
            header: "Coordinates",
            cell: (m) => (
              <span className="num text-xs">
                {m.latitude}, {m.longitude}
              </span>
            ),
          },
          {
            id: "device",
            header: "Device",
            cell: (m) =>
              m.device ? (
                <Link
                  to="/devices/$id"
                  params={{ id: m.device.id }}
                  className="link text-xs"
                >
                  {m.device.name}
                </Link>
              ) : (
                dash
              ),
          },
        ]}
      />
    </section>
  )
}

/** Every tile of this type placed on a floor plan - the impact analysis you
 * want before recolouring, renaming, or deleting a palette entry. */
function PlacedTilesTable({ typeId }: { typeId: string }) {
  const q = useQuery({
    queryKey: ["floor-plan-tiles", "by-tile-type", typeId],
    queryFn: () =>
      api<Paginated<FloorPlanTile>>(
        `/api/floor-plan-tiles/?tile_type=${typeId}&page_size=500`
      ),
  })
  // This page *is* the type, so the "type" column would repeat the title.
  const columns = useMemo<ColumnDef<FloorPlanTile, unknown>[]>(
    () => buildFloorTileColumns({ omit: ["type"] }),
    []
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <EmptyState title="No tiles placed yet.">
        Nothing on any floor plan uses this type. Open a plan and paint one from
        the palette.
      </EmptyState>
    )
  return <DataTable data={rows} columns={columns} flexColumn="label" embedded />
}
