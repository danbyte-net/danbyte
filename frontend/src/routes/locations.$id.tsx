import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus } from "lucide-react"
import { useMemo, useState } from "react"

import {
  api,
  type FloorPlan,
  type Location,
  type Prefix,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { DataTable, SortHeader } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { ObjectImages } from "@/components/object-images"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { EmbeddedDeviceTable } from "@/components/embedded-device-table"
import { EmbeddedRackTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/locations/$id")({
  component: LocationDetail,
})

function LocationDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["location", id],
    queryFn: () => api<Location>(`/api/locations/${id}/`),
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
  return <Body location={q.data} />
}

function Body({ location: l }: { location: Location }) {
  const { canDo, humanIds } = useMe()
  const prefixes = useQuery({
    queryKey: ["location-prefixes", l.id],
    queryFn: () => api<Paginated<Prefix>>(`/api/prefixes/?location=${l.id}`),
  })
  const floorPlans = useQuery({
    queryKey: ["floor-plans", { location: l.id }],
    queryFn: () =>
      api<Paginated<FloorPlan>>(`/api/floor-plans/?location=${l.id}`),
  })
  const floorPlan = floorPlans.data?.results[0]
  const rows = prefixes.data?.results ?? []
  const columns = useMemo<ColumnDef<Prefix>[]>(() => buildColumns(), [])
  const [tab, setTab] = useState<
    "overview" | "devices" | "racks" | "prefixes" | "journal" | "history"
  >("overview")

  return (
    <DetailShell
      backTo="/locations"
      backLabel="Locations"
      title={l.name}
      presence={{ type: "location", id: l.id }}
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <Link to="/racks/elevations" search={{ location: l.id }}>
              Rack elevations
            </Link>
          </Button>
          {floorPlan ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/floorplans/$id" params={{ id: floorPlan.id }}>
                Floor plan
              </Link>
            </Button>
          ) : (
            canDo("floorplan", "add") && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/floorplans/new" search={{ location: l.id }}>
                  <Plus className="h-3.5 w-3.5" /> Floor plan
                </Link>
              </Button>
            )
          )}
          {canDo("location", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/locations/$id/edit" params={{ id: l.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
        </>
      }
      hero={
        <>
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <div className="text-2xl font-semibold tracking-tight">
                {l.name}
              </div>
              <div className="mt-2">
                <StatusBadge status={l.status} />
              </div>
            </div>
          </section>
          {l.description && (
            <p className="shrink-0 border-b border-border px-6 py-4 text-[13px] text-muted-foreground">
              {l.description}
            </p>
          )}
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices" },
        { value: "racks", label: "Racks" },
        { value: "prefixes", label: "Prefix ranges", count: rows.length },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <LocationOverview location={l} humanIds={humanIds} />
      </DetailTab>
      <DetailTab value="devices">
        <EmbeddedDeviceTable
          filter={{ location: l.id }}
          emptyText="No devices in this location yet."
        />
      </DetailTab>
      <DetailTab value="racks">
        <EmbeddedRackTable
          filter={{ location: l.id }}
          emptyText="No racks in this location yet."
        />
      </DetailTab>
      <DetailTab value="prefixes">
        <div className="rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <h3 className="text-sm font-semibold">Prefix ranges</h3>
            <Badge variant="secondary">{rows.length}</Badge>
            {canDo("prefix", "add") && (
              <Button size="sm" className="ml-auto" asChild>
                <Link
                  to="/prefixes/new"
                  search={{
                    cidr: undefined,
                    vrf: undefined,
                    site: l.site?.id ?? undefined,
                    location: l.id,
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> Add prefix range
                </Link>
              </Button>
            )}
          </div>
          {prefixes.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No prefix ranges in this location yet.
            </p>
          ) : (
            <div className="p-3">
              <DataTable
                data={rows}
                columns={columns}
                tableId="location-prefixes"
                flexColumn="description"
                exportName="location-prefixes"
                exportTitle="Prefix ranges"
              />
            </div>
          )}
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.location" objectId={l.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.location" objectId={l.id} />
      </DetailTab>
    </DetailShell>
  )
}

// ─── Prefix-range column definitions ────────────────────────────────────
// Read-only nested table → no selection column. Prefix cells come from the
// shared factory (byte-identical to /prefixes); only the location-specific
// auto-site flag and the IP count are spliced in.
function buildColumns(): ColumnDef<Prefix>[] {
  const cols = buildPrefixColumns<Prefix>({
    include: [
      "cidr",
      "status",
      "description",
      "utilisation",
      "tags",
      "updated",
    ],
  })
  const auto: ColumnDef<Prefix> = {
    id: "auto",
    accessorKey: "auto_assign_site",
    header: "Auto",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.auto_assign_site ? (
        <Badge variant="secondary" className="text-[10px]">
          auto-site
        </Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  }
  const ips: ColumnDef<Prefix> = {
    id: "ips",
    accessorKey: "ip_count",
    header: ({ column }) => <SortHeader column={column} label="IPs" />,
    cell: ({ row }) => (
      <span className="num text-[11px] text-muted-foreground">
        {row.original.ip_count} IP{row.original.ip_count === 1 ? "" : "s"}
      </span>
    ),
  }
  cols.splice(cols.findIndex((c) => c.id === "status") + 1, 0, auto)
  cols.splice(cols.findIndex((c) => c.id === "utilisation") + 1, 0, ips)
  return cols
}

/** The location's attributes, grouped into a labelled table — the detail that
 * used to crowd the page header. Only the name and status stay up top. */
function LocationOverview({
  location: l,
  humanIds,
}: {
  location: Location
  humanIds: boolean
}) {
  const details: KvRow[] = [
    ...(humanIds && l.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{l.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Site", value: l.site ? l.site.name : dash },
    { label: "Parent", value: l.parent ? l.parent.name : dash },
    { label: "Status", value: <StatusBadge status={l.status} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Details" rows={details} />
      </div>
      <ObjectImages
        apiBase={`/api/locations/${l.id}`}
        objectType="location"
      />
    </div>
  )
}
