import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ShowOnFloorPlan } from "@/components/show-on-floor-plan"
import { useQuery } from "@tanstack/react-query"
import { Camera, Minus, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useRef, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type Device, type Paginated, type Rack } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { CustomFieldValues } from "@/components/custom-field-display"
import { ObjectImages } from "@/components/object-images"
import { QueryError } from "@/components/query-error"
import { RackDeleteDialog } from "@/components/rack-delete-dialog"
import {
  RackElevation,
  type RackDisplayMode,
} from "@/components/rack-elevation"
import { StatusBadge } from "@/components/status-badge"
import { KvCard, dash, mono, type KvRow } from "@/components/kv-card"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/racks/$id")({
  component: RackDetail,
})

function RackDetail() {
  const { id } = Route.useParams()
  const rack = useQuery({
    queryKey: ["rack", id],
    queryFn: () => api<Rack>(`/api/racks/${id}/`),
  })
  if (rack.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (rack.isError)
    return (
      <div className="p-6">
        <QueryError error={rack.error} />
      </div>
    )
  if (!rack.data) return null
  return <RackDetailBody rack={rack.data} />
}

function RackDetailBody({ rack: r }: { rack: Rack }) {
  const [tab, setTab] = useState<
    "overview" | "devices" | "journal" | "history"
  >("overview")
  const { canDo } = useMe()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Rack | null>(null)
  const openDelete = useCallback(() => setDeleting(r), [r])
  const goBack = useCallback(() => nav({ to: "/racks" }), [nav])

  return (
    <DetailShell
      backTo="/racks"
      backLabel="Racks"
      title={r.name}
      presence={{ type: "rack", id: r.id }}
      actions={
        <>
          <ShowOnFloorPlan rackId={r.id} />
          {canDo("rack", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/racks/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("rack", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={openDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="text-3xl font-semibold tracking-tight">
                  {r.name}
                </div>
                <StatusBadge status={r.status} />
              </div>
              {r.facility_id && (
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {r.facility_id}
                </p>
              )}
              {r.tags.length > 0 && (
                <div className="mt-2">
                  <TagList tags={r.tags} />
                </div>
              )}
              {r.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {r.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="Site"
                value={
                  <Link
                    to="/sites/$id"
                    params={{ id: r.site.id }}
                    className="text-xs text-primary hover:underline"
                  >
                    {r.site.name}
                  </Link>
                }
              />
              <DetailStat
                label="Height"
                value={<span className="num">{r.u_height}U</span>}
              />
              {(r.power.allocated_w > 0 ||
                r.power.maximum_w > 0 ||
                r.power.available_w > 0) && (
                <DetailStat
                  label="Power"
                  value={<PowerStat power={r.power} />}
                />
              )}
              {(r.total_weight_kg > 0 || r.max_weight_kg != null) && (
                <DetailStat
                  label="Weight"
                  value={
                    <span
                      className={
                        r.max_weight_kg != null &&
                        r.total_weight_kg > r.max_weight_kg
                          ? "num font-medium text-destructive"
                          : "num"
                      }
                    >
                      {r.total_weight_kg} kg
                      {r.max_weight_kg != null && ` / ${r.max_weight_kg} kg`}
                    </span>
                  }
                />
              )}
            </dl>
          </section>

          <CustomFieldValues model="rack" values={r.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices", count: r.device_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <RackOverview rack={r} />
      </DetailTab>
      <DetailTab value="devices">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
          <RackElevation rack={r} scale={0.6} draggable />
          <div className="min-w-0 flex-1">
            <RackDevicesPane rackId={r.id} />
          </div>
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.rack" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.rack" objectId={r.id} />
      </DetailTab>

      <RackDeleteDialog
        rack={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function RackDevicesPane({ rackId }: { rackId: string }) {
  const q = useQuery({
    queryKey: ["rack-devices", rackId],
    queryFn: () => api<Paginated<Device>>(`/api/devices/?rack=${rackId}`),
  })
  const rows = q.data?.results ?? []
  const columns = useMemo<ColumnDef<Device>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "position",
        accessorKey: "position",
        header: ({ column }) => <SortHeader column={column} label="Position" />,
        cell: ({ row }) =>
          row.original.position != null ? (
            <span className="num font-mono text-xs">
              U{row.original.position}
            </span>
          ) : (
            <span className="text-muted-foreground">unracked</span>
          ),
      },
      {
        id: "face",
        accessorKey: "face",
        header: ({ column }) => <SortHeader column={column} label="Face" />,
        cell: ({ row }) =>
          row.original.face ? (
            <span className="text-xs capitalize">{row.original.face}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "height",
        accessorKey: "u_height",
        header: ({ column }) => <SortHeader column={column} label="Height" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.u_height}U</span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    []
  )
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No devices in this rack.</p>
    )
  return <DataTable data={rows} columns={columns} flexColumn="name" embedded />
}

/** The rack's attributes, grouped into labelled tables — the detail that used
 * to crowd the page header. Only name, status, and location stay up top. */
function RackOverview({ rack: r }: { rack: Rack }) {
  const { humanIds } = useMe()
  const util = r.u_height ? Math.round((r.used_units / r.u_height) * 100) : 0
  const rackRows: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Site",
      value: (
        <Link
          to="/sites/$id"
          params={{ id: r.site.id }}
          className="text-primary hover:underline"
        >
          {r.site.name}
        </Link>
      ),
    },
    {
      label: "Role",
      value: r.role ? (
        <ColorBadge name={r.role.name} color={r.role.color || undefined} />
      ) : (
        dash
      ),
    },
    { label: "Facility ID", value: mono(r.facility_id) },
    {
      label: "Location",
      value: r.location ? (
        <Link
          to="/locations/$id"
          params={{ id: r.location.id }}
          className="text-primary hover:underline"
        >
          {r.location.name}
        </Link>
      ) : (
        dash
      ),
    },
  ]
  const capacityRows: KvRow[] = [
    { label: "Height", value: <span className="num">{r.u_height}U</span> },
    {
      label: "Devices",
      value: <span className="num">{r.device_count}</span>,
    },
    {
      label: "Used",
      value: (
        <span className="num">
          {r.used_units} U{" "}
          <span className="text-muted-foreground">({util}%)</span>
        </span>
      ),
    },
  ]
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Rack" rows={rackRows} />
        <KvCard title="Capacity" rows={capacityRows} />
      </div>
      <RackFaces rack={r} />
      <ObjectImages apiBase={`/api/racks/${r.id}`} objectType="rack" />
    </div>
  )
}

/** NetBox-style paired elevations — front and rear side by side, one shared
 * display-mode toggle. Full-depth devices show hatched on the face they're
 * not mounted on. */
// Zoom presets (px per mm). Names/Images default to a compact fit-on-screen
// scale; Render defaults larger so ports stay legible. Users can zoom in/out.
const ZOOM_STEPS = [0.45, 0.6, 0.8, 1.0, 1.3, 1.6, 2.0]
const DEFAULT_ZOOM: Record<RackDisplayMode, number> = {
  names: 0.6,
  images: 0.6,
  render: 1.35,
}

function RackFaces({ rack }: { rack: Rack }) {
  const [mode, setMode] = useState<RackDisplayMode>("names")
  const [labels, setLabels] = useState(true)
  const [zoom, setZoom] = useState(DEFAULT_ZOOM.names)
  const facesRef = useRef<HTMLDivElement>(null)

  // Reset to the mode's sensible default zoom when switching modes.
  const changeMode = (m: RackDisplayMode) => {
    setMode(m)
    setZoom(DEFAULT_ZOOM[m])
  }
  const stepZoom = (dir: -1 | 1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom)
    const cur = i < 0 ? ZOOM_STEPS.length - 1 : i
    const next = Math.min(
      ZOOM_STEPS.length - 1,
      Math.max(0, cur + dir)
    )
    setZoom(ZOOM_STEPS[next])
  }

  // Snapshot both faces to a PNG (html-to-image), theme-aware background.
  const exportPng = async () => {
    const el = facesRef.current
    if (!el) return
    const { toPng } = await import("html-to-image")
    const dark = document.documentElement.classList.contains("dark")
    const url = await toPng(el, {
      backgroundColor: dark ? "#09090b" : "#ffffff",
      pixelRatio: 2,
    })
    const a = document.createElement("a")
    a.href = url
    a.download = `${rack.name}-elevation.png`
    a.click()
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <SegmentedTabs<RackDisplayMode>
          value={mode}
          onValueChange={changeMode}
          items={[
            { value: "names", label: "Names" },
            { value: "images", label: "Images" },
            { value: "render", label: "Render" },
          ]}
        />
        {mode !== "names" && (
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="ck ck-sm"
              checked={labels}
              onChange={(e) => setLabels(e.target.checked)}
            />
            Text
          </label>
        )}
        {/* Zoom — shrink to fit the whole rack on screen, or zoom in for detail. */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => stepZoom(-1)}
            disabled={zoom <= ZOOM_STEPS[0]}
            aria-label="Zoom out"
          >
            <Minus className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => stepZoom(1)}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            aria-label="Zoom in"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7 text-xs"
          onClick={exportPng}
        >
          <Camera className="h-3 w-3" /> PNG
        </Button>
      </div>
      <div
        ref={facesRef}
        className="flex flex-col gap-8 lg:flex-row lg:items-start"
      >
        {(["front", "rear"] as const).map((f) => (
          <div key={f}>
            <h3 className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              {f}
            </h3>
            <RackElevation
              rack={rack}
              face={f}
              mode={mode}
              labels={labels}
              showHeader={false}
              scale={zoom}
              draggable
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/** "demand / supply W" — demand prefers recorded allocated draw, falling
 * back to the nameplate sum; red when demand exceeds the feeds' capacity. */
function PowerStat({
  power,
}: {
  power: { available_w: number; allocated_w: number; maximum_w: number }
}) {
  const demand = power.allocated_w > 0 ? power.allocated_w : power.maximum_w
  const over = power.available_w > 0 && demand > power.available_w
  return (
    <span className={over ? "num font-medium text-destructive" : "num"}>
      {demand} W{power.available_w > 0 && ` / ${power.available_w} W`}
      {power.allocated_w === 0 && power.maximum_w > 0 && (
        <span className="ml-1 text-[11px] font-normal text-muted-foreground">
          nameplate
        </span>
      )}
    </span>
  )
}
