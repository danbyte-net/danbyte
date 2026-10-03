import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { ShowOnFloorPlan } from "@/components/show-on-floor-plan"
import { PrintLabelButton } from "@/components/print-label-button"
import { RackSyncTypeButton } from "@/components/rack-sync-type-button"
import { useQuery } from "@tanstack/react-query"
import { Minus, Pencil, Plus, Trash2 } from "lucide-react"
import {
  Suspense,
  lazy,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { Device, Paginated, Rack, RackPortState } from "@/lib/api"
import { portsUsed, useRackPortState } from "@/lib/rack-port-state"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { CustomFieldValues } from "@/components/custom-field-display"
import { ObjectImages } from "@/components/object-images"
import { ObjectDocuments } from "@/components/object-documents"
import { QueryError } from "@/components/query-error"
import { RackDeleteDialog } from "@/components/rack-delete-dialog"
import { RackElevation } from "@/components/rack-elevation"
import type { RackDisplayMode, RackShow } from "@/components/rack-elevation"
import { StatusBadge } from "@/components/status-badge"
import { KvCard, dash, mono, type KvRow } from "@/components/kv-card"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { BarIconButton } from "@/components/map-toolbar"
import { DrawingDisplayMenu } from "@/components/drawing-display-menu"
import { setLivePortsShown, useLivePortsShown } from "@/lib/live-ports-pref"
import { RackExportMenu } from "@/components/rack-export-menu"
import { Loading } from "@/components/loading"
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
  if (rack.isLoading) return <Loading />
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
  const [tab, setTab] = useUrlTab<
    "overview" | "devices" | "documents" | "journal" | "history"
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
          <PrintLabelButton objectType="rack" ids={[r.id]} />
          <RackSyncTypeButton rack={r} />
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
        <DetailHero
          title={r.name}
          badges={<StatusBadge status={r.status} />}
          subtitle={
            r.facility_id && <span className="font-mono">{r.facility_id}</span>
          }
          tags={r.tags.length > 0 && <TagList tags={r.tags} />}
          description={r.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices", count: r.device_count },
        { value: "documents", label: "Documents", count: r.document_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
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
      <DetailTab value="documents">
        <ObjectDocuments objectType="api.rack" objectId={r.id} />
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
  const columns = useMemo<ColumnDef<Device>[]>(() => {
    // Shared name + status from the device factory; the rack placement columns
    // (position, face, height) are this pane's own and sit between them.
    const [name, status] = buildDeviceColumns({
      include: ["name", "status"],
    })
    return [
      name,
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
            <span className="text-muted-foreground">-</span>
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
      status,
    ]
  }, [])
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No devices in this rack.</p>
    )
  return <DataTable data={rows} columns={columns} flexColumn="name" embedded />
}

/** The rack's attributes, grouped into labelled tables - the detail that used
 * to crowd the page header. Only name, status, facility ID, tags and
 * description stay up top. */
function RackOverview({ rack: r }: { rack: Rack }) {
  const { humanIds } = useMe()
  // Every port in the rack, in one request while the Overview shows: the
  // Capacity card's Ports and the elevation's live faces read it.
  const portState = useRackPortState(r.id)
  const rackPorts = portState.data?.rack.ports
  const util = r.u_height ? Math.round((r.used_units / r.u_height) * 100) : 0
  const hasPower =
    r.power.allocated_w > 0 || r.power.maximum_w > 0 || r.power.available_w > 0
  const overWeight =
    r.max_weight_kg != null && r.total_weight_kg > r.max_weight_kg
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
        <Link to="/sites/$id" params={{ id: r.site.id }} className="link">
          {r.site.name}
        </Link>
      ),
    },
    {
      label: "Role",
      value: r.role ? (
        <Link to="/rack-roles/$id" params={{ id: r.role.id }} className="link">
          <ColorBadge name={r.role.name} color={r.role.color || undefined} />
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Rack type",
      value: r.rack_type ? (
        <Link
          to="/rack-types/$id"
          params={{ id: r.rack_type.id }}
          className="link"
        >
          {r.rack_type.manufacturer
            ? `${r.rack_type.manufacturer.name} ${r.rack_type.name}`
            : r.rack_type.name}
        </Link>
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
          className="link"
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
    {
      label: "Free",
      value: (
        <span className="num">{Math.max(0, r.u_height - r.used_units)} U</span>
      ),
    },
    {
      label: "Ports",
      value: rackPorts ? (
        rackPorts.total > 0 ? (
          // The per-device breakdown is the Port utilization page's.
          <Link
            to="/port-utilization"
            search={{ rack: r.id }}
            className="link num"
          >
            {portsUsed(rackPorts)} / {rackPorts.total}
          </Link>
        ) : (
          dash
        )
      ) : portState.isError ? (
        dash
      ) : (
        <span className="text-muted-foreground">…</span>
      ),
    },
    {
      label: "Power",
      value: hasPower ? <PowerStat power={r.power} /> : dash,
    },
    {
      label: "Weight",
      value:
        r.total_weight_kg > 0 || r.max_weight_kg != null ? (
          <span
            className={overWeight ? "num font-medium text-destructive" : "num"}
          >
            {r.total_weight_kg} kg
            {r.max_weight_kg != null && ` / ${r.max_weight_kg} kg`}
          </span>
        ) : (
          dash
        ),
    },
  ]
  return (
    <div className="space-y-6">
      {/* The rack gets the wider column, as the cabinet's plate does. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,5fr)]">
        <div className="grid content-start gap-6">
          <KvCard title="Rack" rows={rackRows} />
          <CustomFieldValues
            model="rack"
            values={r.custom_fields}
            layout="cards"
          />
          <KvCard title="Capacity" rows={capacityRows} />
        </div>
        <RackFaces rack={r} ports={portState.data} />
      </div>
      <ObjectImages apiBase={`/api/racks/${r.id}`} objectType="rack" />
    </div>
  )
}

/** Paired elevations - front and rear side by side, one shared
 * display-mode toggle. Full-depth devices show hatched on the face they're
 * not mounted on. */
// Zoom presets (px per mm). Names/Images default to a compact fit-on-screen
// scale; Render defaults larger so ports stay legible. Users can zoom in/out.
const ZOOM_STEPS = [0.35, 0.45, 0.6, 0.8, 1.0, 1.3, 1.6, 2.0]
const DEFAULT_ZOOM: Record<RackDisplayMode, number> = {
  names: 0.6,
  images: 0.6,
  render: 1.35,
}

// The rack in 3D - three.js and all, in its own chunk.
const RackScene = lazy(() => import("@/components/floorplan3d/rack-scene"))

const VIZ = ["2d", "3d"] as const
type Viz = (typeof VIZ)[number]

const SHOWS: readonly RackShow[] = ["all", "front", "rear"]
const SHOW_OPTIONS: readonly { value: RackShow; label: string }[] = [
  { value: "all", label: "All" },
  { value: "front", label: "Front-mounted" },
  { value: "rear", label: "Rear-mounted" },
]

function RackFaces({ rack, ports }: { rack: Rack; ports?: RackPortState }) {
  // The rack in 2D or in 3D, in the URL as the cabinet keeps its plate's.
  const [viz, setViz] = useUrlTab<Viz>("2d", "viz", VIZ)
  const vizSwitch = (
    <SegmentedTabs<Viz>
      value={viz}
      onValueChange={setViz}
      items={[
        { value: "2d", label: "2D" },
        { value: "3d", label: "3D" },
      ]}
    />
  )
  const [mode, setMode] = useState<RackDisplayMode>("names")
  const [labels, setLabels] = useState(true)
  // Which gear to show, in the URL like the 2D | 3D switch; the live ports,
  // a choice this browser keeps (Ports, shared with the cabinet's plate).
  const [show, setShow] = useUrlTab<RackShow>("all", "show", SHOWS)
  const livePorts = useLivePortsShown()
  const [zoom, setZoom] = useState(DEFAULT_ZOOM.names)
  const facesRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  // Until someone zooms by hand, the zoom steps down until front and rear
  // fit side by side in the frame, and starts over when the frame resizes.
  const [manual, setManual] = useState(false)
  const [frameWidth, setFrameWidth] = useState(0)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const ro = new ResizeObserver(() => setFrameWidth(frame.clientWidth))
    ro.observe(frame)
    return () => ro.disconnect()
  }, [viz])
  useLayoutEffect(() => {
    if (!manual) setZoom(DEFAULT_ZOOM[mode])
  }, [frameWidth, manual, mode])
  useLayoutEffect(() => {
    const frame = frameRef.current
    const faces = facesRef.current
    if (manual || !frame || !faces) return
    if (faces.scrollWidth > frame.clientWidth) {
      const smaller = [...ZOOM_STEPS].reverse().find((z) => z < zoom)
      if (smaller) setZoom(smaller)
    }
  }, [zoom, manual, frameWidth])

  // Reset to the mode's sensible default zoom when switching modes.
  const changeMode = (m: RackDisplayMode) => {
    setMode(m)
    setManual(false)
    setZoom(DEFAULT_ZOOM[m])
  }
  const stepZoom = (dir: -1 | 1) => {
    setManual(true)
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom)
    const cur = i < 0 ? ZOOM_STEPS.length - 1 : i
    const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, cur + dir))
    setZoom(ZOOM_STEPS[next])
  }

  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Elevation
        </h2>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        {viz === "3d" ? (
          <Suspense
            fallback={
              <>
                <div className="mb-3 flex items-center">{vizSwitch}</div>
                <Loading className="h-[40rem] max-h-[80vh]" />
              </>
            }
          >
            <RackScene rackId={rack.id} lead={vizSwitch} />
          </Suspense>
        ) : (
          <>
            <div
              data-part="elevation-toolbar"
              className="@container mb-3 flex items-center gap-3"
            >
              {vizSwitch}
              <SegmentedTabs<RackDisplayMode>
                value={mode}
                onValueChange={changeMode}
                items={[
                  { value: "names", label: "Names" },
                  { value: "images", label: "Images" },
                  { value: "render", label: "Render" },
                ]}
              />
              <DrawingDisplayMenu<RackShow>
                ticks={[
                  ...(mode !== "names"
                    ? [{ label: "Text", checked: labels, onChange: setLabels }]
                    : []),
                  {
                    label: "Ports",
                    checked: livePorts,
                    onChange: setLivePortsShown,
                  },
                ]}
                choice={{
                  label: "Show",
                  value: show,
                  options: SHOW_OPTIONS,
                  onChange: setShow,
                }}
              />
              <div className="flex items-center gap-1">
                <BarIconButton
                  label="Zoom out"
                  disabled={zoom <= ZOOM_STEPS[0]}
                  onClick={() => stepZoom(-1)}
                >
                  <Minus />
                </BarIconButton>
                <BarIconButton
                  label="Zoom in"
                  disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                  onClick={() => stepZoom(1)}
                >
                  <Plus />
                </BarIconButton>
              </div>
              <RackExportMenu
                rack={rack}
                mode={mode}
                labels={labels}
                show={show}
                snapshot={facesRef}
                className="ml-auto"
              />
            </div>
            <div ref={frameRef} className="overflow-auto">
              <div
                ref={facesRef}
                className="mx-auto flex w-max items-start gap-8"
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
                      ports={livePorts ? ports : undefined}
                      show={show}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/** "demand / supply W" - demand prefers recorded allocated draw, falling
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
