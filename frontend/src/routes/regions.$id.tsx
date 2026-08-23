import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type Paginated, type Region, type Site } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { SimpleTable } from "@/components/ui/simple-table"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { RegionDeleteDialog } from "@/components/region-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { MiniMap } from "@/components/site-map/mini-map"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/regions/$id")({
  component: RegionDetail,
})

function RegionDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["region", id],
    queryFn: () => api<Region>(`/api/regions/${id}/`),
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
  return <Body region={q.data} />
}

function Body({ region: r }: { region: Region }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "sites" | "sub-regions" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<Region | null>(null)
  const goBack = useCallback(() => nav({ to: "/regions" }), [nav])

  return (
    <DetailShell
      backTo="/regions"
      backLabel="Regions"
      title={r.name}
      presence={{ type: "region", id: r.id }}
      actions={
        <>
          {canDo("region", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/regions/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("region", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={r.name}
          subtitle={
            r.parent && (
              <Link
                to="/regions/$id"
                params={{ id: r.parent.id }}
                className="link"
              >
                {r.parent.name}
              </Link>
            )
          }
          description={r.description}
          stats={
            <>
              <DetailStat
                label="Sites"
                value={<span className="num">{r.site_count}</span>}
              />
              <DetailStat
                label="Sub-regions"
                value={<span className="num">{r.child_count}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "sites", label: "Sites", count: r.site_count },
        { value: "sub-regions", label: "Sub-regions", count: r.child_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <RegionOverview region={r} />
      </DetailTab>
      <DetailTab value="sites">
        <RegionSitesTable regionId={r.id} />
      </DetailTab>
      <DetailTab value="sub-regions">
        <SubRegionsTable parentId={r.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.region" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.region" objectId={r.id} />
      </DetailTab>

      <RegionDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function RegionOverview({ region: r }: { region: Region }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{r.slug}</span>,
      copy: r.slug,
    },
    {
      label: "Parent region",
      value: r.parent ? (
        <Link to="/regions/$id" params={{ id: r.parent.id }} className="link">
          {r.parent.name}
        </Link>
      ) : (
        dash
      ),
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Region" rows={details} />
        <KvCard title="Record" rows={record} />
      </div>
      {r.boundary && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            Boundary
          </h2>
          <div className="relative h-96 overflow-hidden rounded-lg border border-border">
            <MiniMap
              className="h-full w-full"
              boundary={{ geometry: r.boundary, color: r.color }}
            />
            <Link
              to="/site-map"
              className="absolute right-2 bottom-2 z-[500] rounded-md border border-border bg-background/85 px-2 py-1 text-[11px] backdrop-blur hover:bg-background"
              title="Open the Site map"
            >
              Open map →
            </Link>
          </div>
          {r.boundary_label && (
            <p
              className="mt-1.5 truncate text-xs text-muted-foreground"
              title={r.boundary_label}
            >
              {r.boundary_label} · © OpenStreetMap contributors
            </p>
          )}
        </section>
      )}
    </div>
  )
}

/** Sites that sit directly in this region. */
function RegionSitesTable({ regionId }: { regionId: string }) {
  const q = useQuery({
    queryKey: ["sites", "by-region", regionId],
    queryFn: () =>
      api<Paginated<Site>>(`/api/sites/?region=${regionId}&page_size=500`),
  })
  const rows = q.data?.results ?? []
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <SimpleTable<Site>
      data={rows}
      getRowKey={(s) => s.id}
      empty="No sites in this region yet."
      columns={[
        {
          id: "name",
          header: "Name",
          flex: true,
          cell: (s) => (
            <Link
              to="/sites/$id"
              params={{ id: s.id }}
              className="link font-medium"
            >
              {s.name}
            </Link>
          ),
        },
        {
          id: "location",
          header: "Location",
          cell: (s) => (
            <span className="text-xs text-muted-foreground">
              {s.location || "-"}
            </span>
          ),
        },
        {
          id: "devices",
          header: "Devices",
          align: "right",
          cell: (s) => <span className="num text-xs">{s.device_count}</span>,
        },
      ]}
    />
  )
}

/** Regions nested directly under this one. */
function SubRegionsTable({ parentId }: { parentId: string }) {
  const q = useQuery({
    queryKey: ["regions", "by-parent", parentId],
    queryFn: () =>
      api<Paginated<Region>>(`/api/regions/?parent=${parentId}&page_size=500`),
  })
  const rows = q.data?.results ?? []
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <SimpleTable<Region>
      data={rows}
      getRowKey={(sr) => sr.id}
      empty="No sub-regions yet."
      columns={[
        {
          id: "name",
          header: "Name",
          flex: true,
          cell: (sr) => (
            <Link
              to="/regions/$id"
              params={{ id: sr.id }}
              className="link font-medium"
            >
              {sr.name}
            </Link>
          ),
        },
        {
          id: "sites",
          header: "Sites",
          align: "right",
          cell: (sr) => <span className="num text-xs">{sr.site_count}</span>,
        },
        {
          id: "children",
          header: "Sub-regions",
          align: "right",
          cell: (sr) => <span className="num text-xs">{sr.child_count}</span>,
        },
      ]}
    />
  )
}
