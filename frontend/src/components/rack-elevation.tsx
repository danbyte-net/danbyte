import { Fragment, useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { CalendarClock } from "lucide-react"

import { api } from "@/lib/api"
import type {
  Device,
  Paginated,
  PlanningPlannedChange,
  PortCountRow,
  Rack,
  RackPortState,
} from "@/lib/api"
import { readableText } from "@/components/cells/color-badge"
import { OPENING_MM, PANEL_MM } from "@/lib/faceplate-geometry"
import { unitRow } from "@/lib/rack-placement"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DevicePicker } from "@/components/device-picker"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { FormCheckbox } from "@/components/forms"
import { TypeFaceplate, useSavedFaceplate } from "@/components/device-faceplate"
import type { PortTrace } from "@/components/device-faceplate"
import { CableTraceDialog } from "@/components/cable-trace-dialog"
import { InterfaceTraceDialog } from "@/components/interface-trace-dialog"
import { PortsBadge, RackLiveFace } from "@/components/rack-live-face"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { apiErrorToast } from "@/lib/api-toast"

// Every mode draws mm-true rows so switching modes never resizes the rack:
// Names/Images share one scale (19″ → ~430px wide, ~42px per U); Render is
// larger so individual ports stay legible.
const BASE_PX_PER_MM = 0.95
const RENDER_PX_PER_MM = 1.35

export type RackFace = "front" | "rear"
export type RackDisplayMode = "names" | "images" | "render"
/** Which gear the elevation shows: all of it, or only what is mounted on
 * one face - the rest still takes its units, hatched. */
export type RackShow = "all" | "front" | "rear"

/** How a device draws on a face: its front where it is mounted (`own`), its
 * other side where it is full depth (`other`), or as hatched space the Show
 * filter keeps it out of (`hidden`). */
type BlockView = "own" | "other" | "hidden"

/** The device form's unit picker: the elevation drawn for placing one
 * device. Device blocks stop being links, the page's add, assign and drag
 * affordances, side lanes and planned moves go, and a press on a unit - free
 * or taken, a block lets it through - calls `onUnit`. */
export interface RackUnitPicker {
  /** Left out of the drawing: the device being placed. */
  exclude?: string
  onUnit: (unit: number) => void
  /** The unit under the pointer; null once it leaves the units. */
  onHover?: (unit: number | null) => void
  /** Drawn over the units, as grid items: the device being placed. */
  overlay?: ReactNode
}

export function RackElevation({
  rack,
  face: controlledFace,
  mode: controlledMode,
  labels: controlledLabels,
  highlightDeviceId,
  showHeader = true,
  scale,
  draggable = false,
  picker,
  ports,
  show = "all",
}: {
  rack: Rack
  /** Controlled face - hides the internal Front/Rear toggle. */
  face?: RackFace
  /** Controlled display mode - hides the internal mode toggle. */
  mode?: RackDisplayMode
  /** Overlay names on image/render blocks (controlled - hides the tick). */
  labels?: boolean
  /** Ring the matching device block (e.g. on its own detail page). */
  highlightDeviceId?: string
  showHeader?: boolean
  /** px per mm - bump for hero contexts (rack detail page). Render mode
   * never drops below its own minimum so ports stay legible. */
  scale?: number
  /** Rack page: drag device blocks between units to re-position them. */
  draggable?: boolean
  /** The device form: pick a unit for the device being placed. */
  picker?: RackUnitPicker
  /** The rack page (#248): the rack's port state. Every block then shows
   * its ports in use over its counted ports; Images and Render draw each
   * device's ports live, as its device page does, and a press on a cabled
   * port opens its trace. */
  ports?: RackPortState
  /** Only the gear mounted on one face; the rest is hatched space. */
  show?: RackShow
}) {
  const [faceState, setFace] = useState<RackFace>("front")
  const [modeState, setMode] = useState<RackDisplayMode>("names")
  const [labelsState, setLabels] = useState(true)
  const [assignUnit, setAssignUnit] = useState<number | null>(null)
  const [assignSide, setAssignSide] = useState<
    "side_left" | "side_right" | null
  >(null)
  const { canDo } = useMe()
  const canAddDevice = !picker && canDo("device", "add")
  const canMoveDevice = !picker && canDo("device", "change")
  const canDrag = draggable && canMoveDevice
  const qc = useQueryClient()
  const [dragging, setDragging] = useState<Device | null>(null)
  // A cabled port pressed on a live face: its run, in a dialog.
  const [trace, setTrace] = useState<PortTrace | null>(null)
  const sensors = useSensors(
    // 6px activation distance keeps plain clicks navigating to the device.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const move = useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) =>
      api<Device>(`/api/devices/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ position }),
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["rack-devices", rack.id] })
      qc.invalidateQueries({ queryKey: ["rack", rack.id] })
      toast.success(`${d.name} → U${d.position}`)
    },
    onError: (err) => apiErrorToast(err),
  })
  const face = controlledFace ?? faceState
  const mode = controlledMode ?? modeState
  const labels = controlledLabels ?? labelsState

  const q = useQuery({
    queryKey: ["rack-devices", rack.id],
    queryFn: () => api<Paginated<Device>>(`/api/devices/?rack=${rack.id}`),
  })

  // Units ordered as they appear visually, top → bottom.
  //   desc_units=false (default): highest U at the top (descending values).
  //   desc_units=true:            U at starting_unit at the top (ascending).
  const units = useMemo(() => {
    const first = rack.starting_unit
    const last = rack.starting_unit + rack.u_height - 1
    const out: number[] = []
    if (rack.desc_units) {
      for (let u = first; u <= last; u++) out.push(u)
    } else {
      for (let u = last; u >= first; u--) out.push(u)
    }
    return out
  }, [rack.starting_unit, rack.u_height, rack.desc_units])

  // Map a unit number to its 1-based grid row (top = row 1).
  const rowOf = (unit: number) => unitRow(rack, unit)

  const exclude = picker?.exclude
  const onHover = picker?.onHover
  const devices = useMemo(() => {
    const all = q.data?.results ?? []
    return exclude ? all.filter((d) => d.id !== exclude) : all
  }, [q.data, exclude])
  // Side-mounted 0U strips (vertical PDUs) - they live in the rail lanes
  // flanking the U grid, not in it. A strip's `face` says which CHANNEL it
  // bolts into, so it only shows on that elevation; blank means unspecified
  // and shows on both (how everything mounted before the field existed
  // behaves, and honest - we don't know which channel it's in).
  const onThisFace = (d: Device) => !d.face || d.face === face
  const mountedLeft = devices.filter(
    (d) => d.mount === "side_left" && onThisFace(d)
  )
  const mountedRight = devices.filter(
    (d) => d.mount === "side_right" && onThisFace(d)
  )
  // Mounting semantics: a device mounts on ONE face (face "" ≈ front); when its
  // type is full-depth it *occupies* the opposite face too and shows its
  // other side there - its rear plate, or hatching where the type has none.
  // A shallow device leaves the other face free. A device the Show filter
  // leaves out still takes its units, hatched, so used and free U stay true.
  const visible = useMemo(
    () =>
      devices
        .filter((d) => d.position != null)
        .map((d) => {
          const mounted: RackFace = d.face === "rear" ? "rear" : "front"
          const own = mounted === face
          if (!own && !(d.device_type?.is_full_depth ?? true)) return null
          const view: BlockView =
            show !== "all" && mounted !== show
              ? "hidden"
              : own
                ? "own"
                : "other"
          return { d, view }
        })
        .filter((x): x is { d: Device; view: BlockView } => x !== null),
    [devices, face, show]
  )

  // Planned rack-elevation moves, drawn as ghosts: a device in THIS rack
  // whose open planned change touches position/face (and stays in this rack)
  // shows a dashed outline at the planned spot - the graphic's version of the
  // calendar-clock field mark.
  const plansQ = useQuery({
    queryKey: ["planned-changes-open"],
    queryFn: () =>
      api<Paginated<PlanningPlannedChange>>(
        "/api/planning/planned-changes/?state=planned&page_size=300"
      ),
    staleTime: 60_000,
    enabled: !picker,
  })
  const ghosts = useMemo(() => {
    const out: {
      dev: Device
      position: number
      ghostFace: RackFace
      fromLabel: string
    }[] = []
    for (const c of plansQ.data?.results ?? []) {
      if (c.object_type !== "api.device" || c.kind !== "update") continue
      const dev = devices.find((d) => d.id === c.object_id)
      if (!dev || dev.position == null) continue
      const p = c.payload
      if (!("position" in p) && !("face" in p) && !("rack_id" in p)) continue
      // Leaving this rack: no spot here to ghost. (The field marks on the
      // device page carry that story.)
      if ("rack_id" in p && String(p.rack_id) !== rack.id) continue
      const position =
        "position" in p && p.position != null
          ? Number(p.position)
          : dev.position
      const ghostFace: RackFace =
        ("face" in p ? p.face : dev.face) === "rear" ? "rear" : "front"
      const sameSpot =
        position === dev.position &&
        ghostFace === (dev.face === "rear" ? "rear" : "front")
      if (sameSpot || !Number.isFinite(position)) continue
      out.push({
        dev,
        position,
        ghostFace,
        fromLabel: `U${dev.position} → U${position}`,
      })
    }
    return out
  }, [plansQ.data, devices, rack.id])

  // Proportions: mm-true rows at widths that follow the rack's physical
  // opening (a real 1U blade is ~10:1 - squeezing it into short rows is what
  // made photos look mangled), so a 10″ rack reads narrower than a 23″ one
  // and switching display modes never resizes the rack.
  const openingMm = OPENING_MM[rack.width] ?? PANEL_MM.opening
  const pxPerMm =
    mode === "render"
      ? Math.max(RENDER_PX_PER_MM, scale ?? 0)
      : (scale ?? BASE_PX_PER_MM)
  const rowHeight = Math.round(PANEL_MM.uPitch * pxPerMm)
  const gridMinWidth = Math.round(openingMm * pxPerMm) + 40

  const onDragStart = (e: DragStartEvent) => {
    setDragging(devices.find((d) => d.id === e.active.id) ?? null)
  }

  const onDragEnd = (e: DragEndEvent) => {
    const dev = dragging
    setDragging(null)
    if (!dev || !e.over) return
    const unit = Number(e.over.id)
    const h = Math.max(1, dev.u_height)
    // The band you drop on becomes the device's TOP visual unit.
    const position = rack.desc_units ? unit : unit - (h - 1)
    const first = rack.starting_unit
    const last = rack.starting_unit + rack.u_height - 1
    if (position < first || position + h - 1 > last) {
      toast.error("Doesn't fit there - runs past the rack.")
      return
    }
    if (position === dev.position) return
    // Client-side overlap check, mirroring the render rules: a device blocks
    // its mounted face, plus the other face when full-depth; half-width
    // blocks only its column.
    const span = new Set(Array.from({ length: h }, (_, i) => position + i))
    const cols = (x: Device) =>
      x.rack_width === "half"
        ? [x.rack_side === "right" ? "right" : "left"]
        : ["left", "right"]
    const devCols = cols(dev)
    const blocked = devices.some((o) => {
      if (o.id === dev.id || o.position == null) return false
      const mounted = o.face === "rear" ? "rear" : "front"
      const full = o.device_type?.is_full_depth ?? true
      const devMounted = dev.face === "rear" ? "rear" : "front"
      const facesClash =
        mounted === devMounted ||
        full ||
        (dev.device_type?.is_full_depth ?? true)
      if (!facesClash) return false
      if (!cols(o).some((c) => devCols.includes(c))) return false
      const oh = Math.max(1, o.u_height)
      for (let u = o.position; u < o.position + oh; u++)
        if (span.has(u)) return true
      return false
    })
    if (blocked) {
      toast.error("That space is occupied.")
      return
    }
    move.mutate({ id: dev.id, position })
  }

  return (
    // Definite width (not max/fit alone): an empty face must render exactly
    // as wide as a populated one, even inside content-sized flex rows.
    <div className="w-fit max-w-full" style={{ minWidth: gridMinWidth }}>
      {showHeader && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {controlledFace === undefined && (
            <SegmentedTabs<RackFace>
              value={face}
              onValueChange={setFace}
              items={[
                { value: "front", label: "Front" },
                { value: "rear", label: "Rear" },
              ]}
            />
          )}
          {controlledMode === undefined && (
            <SegmentedTabs<RackDisplayMode>
              value={mode}
              onValueChange={setMode}
              items={[
                { value: "names", label: "Names" },
                { value: "images", label: "Images" },
                { value: "render", label: "Render" },
              ]}
            />
          )}
          {controlledLabels === undefined && mode !== "names" && (
            <FormCheckbox
              label="Text"
              checked={labels}
              onChange={setLabels}
              className="items-center gap-1 text-[11px] text-muted-foreground"
            />
          )}
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {rack.width}″ · {rack.used_units} / {rack.u_height} U
          </span>
        </div>
      )}

      {q.isError ? (
        <QueryError error={q.error} />
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={canDrag ? onDragStart : undefined}
          onDragEnd={canDrag ? onDragEnd : undefined}
        >
          <div className="overflow-x-auto rounded-lg border border-border bg-card p-1.5">
            <div className="flex gap-1.5">
              {!picker && (mountedLeft.length > 0 || canAddDevice) && (
                <SideLane
                  side="side_left"
                  devices={mountedLeft}
                  rackId={rack.id}
                  canAdd={canAddDevice}
                  onAssign={
                    canMoveDevice ? () => setAssignSide("side_left") : undefined
                  }
                />
              )}
              <div
                className="relative grid flex-1"
                onPointerLeave={onHover ? () => onHover(null) : undefined}
                style={{
                  gridTemplateRows: `repeat(${rack.u_height}, ${rowHeight}px)`,
                  // Two columns so half-width devices (rack_width="half") can
                  // sit side by side in one U; full-width blocks span both.
                  gridTemplateColumns: "1fr 1fr",
                  minWidth: gridMinWidth,
                }}
              >
                {/* Empty "available" bands - one per unit. Devices overlay on
                top, so these hover affordances only surface on free space. */}
                {units.map((unit, i) => (
                  <UnitBand
                    key={unit}
                    unit={unit}
                    row={i + 1}
                    droppable={canDrag}
                    onPick={picker ? () => picker.onUnit(unit) : undefined}
                    onEnter={onHover ? () => onHover(unit) : undefined}
                  >
                    <span className="w-6 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                      {unit}
                    </span>
                    {(canAddDevice || canMoveDevice) && (
                      <span className="ml-auto hidden items-center gap-1.5 group-hover/unit:flex">
                        {canAddDevice && (
                          <Link
                            to="/devices/new"
                            search={{ rack: rack.id, position: unit, face }}
                            className="link rounded px-1 text-[10px] font-medium"
                          >
                            + Add
                          </Link>
                        )}
                        {canMoveDevice && (
                          <button
                            type="button"
                            onClick={() => setAssignUnit(unit)}
                            className="link rounded px-1 text-[10px] font-medium"
                          >
                            Assign
                          </button>
                        )}
                      </span>
                    )}
                  </UnitBand>
                ))}

                {/* Device blocks spanning their u_height. */}
                {visible.map(({ d, view }) => {
                  // When desc_units is false (highest at top), a device occupying
                  // positions p..p+h-1 starts visually at its *top-most* unit
                  // (p+h-1), so anchor on that row; ascending anchors on p.
                  const topUnit = rack.desc_units
                    ? (d.position as number)
                    : (d.position as number) + d.u_height - 1
                  const top = rowOf(topUnit)
                  // Half-width devices occupy one of the two grid columns;
                  // full-width spans both.
                  const column =
                    d.rack_width === "half"
                      ? d.rack_side === "right"
                        ? "2"
                        : "1"
                      : "1 / -1"
                  const span = Math.max(1, d.u_height)
                  const accent = rack.role?.color || undefined
                  const own = view === "own"
                  // The rack page's live face, over the block it belongs to:
                  // in Render, and in Images where the side it shows has a
                  // photo - without one the block draws itself.
                  const photo = own
                    ? d.device_type?.front_image
                    : d.device_type?.rear_image
                  const liveMode =
                    view === "hidden" || mode === "names"
                      ? null
                      : mode === "images" && !photo
                        ? null
                        : mode
                  const live = liveMode ? ports?.devices[d.id] : undefined
                  return (
                    <Fragment key={d.id}>
                      <DeviceBlock
                        device={d}
                        face={face}
                        mode={mode}
                        view={view}
                        dragEnabled={canDrag && own}
                        highlight={d.id === highlightDeviceId}
                        showText={labels}
                        startRow={top}
                        // span clamps to the visible grid in case of overflow
                        span={span}
                        column={column}
                        accent={accent}
                        inert={!!picker}
                        live={!!live}
                        ports={own ? ports?.devices[d.id]?.ports : undefined}
                        countVirtual={ports?.rack.count_virtual}
                      />
                      {live && liveMode && (
                        <RackLiveFace
                          device={d}
                          state={live}
                          mode={liveMode}
                          side={own ? "front" : "rear"}
                          pxPerMm={pxPerMm}
                          text={labels}
                          countPorts={own}
                          countVirtual={ports?.rack.count_virtual}
                          onTrace={setTrace}
                          className={cn(dragging?.id === d.id && "opacity-40")}
                          style={{
                            gridColumn: column,
                            gridRow: `${Math.max(1, top)} / span ${span}`,
                            // Clear of the block's accent rail.
                            borderLeftWidth: accent ? 3 : undefined,
                          }}
                        />
                      )}
                    </Fragment>
                  )
                })}
                {ghosts
                  .filter((g) => !picker && g.ghostFace === face)
                  .map((g) => {
                    const h = Math.max(1, g.dev.u_height)
                    const topUnit = rack.desc_units
                      ? g.position
                      : g.position + h - 1
                    const column =
                      g.dev.rack_width === "half"
                        ? g.dev.rack_side === "right"
                          ? "2"
                          : "1"
                        : "1 / -1"
                    return (
                      <div
                        key={`ghost-${g.dev.id}`}
                        className="z-10 m-px flex items-center justify-center gap-1 truncate rounded-md border border-dashed border-primary/70 bg-primary/10 px-2 text-[11px] text-primary"
                        style={{
                          gridRow: `${rowOf(topUnit)} / span ${h}`,
                          gridColumn: column,
                        }}
                        title={`Planned move: ${g.dev.name} ${g.fromLabel}`}
                      >
                        <CalendarClock className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {g.dev.name} {g.fromLabel}
                        </span>
                      </div>
                    )
                  })}
                {picker?.overlay}
              </div>
              {!picker && (mountedRight.length > 0 || canAddDevice) && (
                <SideLane
                  side="side_right"
                  devices={mountedRight}
                  rackId={rack.id}
                  canAdd={canAddDevice}
                  onAssign={
                    canMoveDevice
                      ? () => setAssignSide("side_right")
                      : undefined
                  }
                />
              )}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <div className="rounded-md border border-primary bg-card px-2 py-1 font-mono text-[11px] shadow-sm">
                {dragging.name} · {dragging.u_height}U
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {q.isLoading && <Loading className="mt-2 min-h-16" />}

      <SideAssignDialog
        rack={rack}
        side={assignSide}
        onOpenChange={(o) => !o && setAssignSide(null)}
      />
      <AssignDeviceDialog
        rack={rack}
        unit={assignUnit}
        face={face}
        onOpenChange={(o) => !o && setAssignUnit(null)}
      />
      {ports && (
        <>
          <InterfaceTraceDialog
            target={
              trace?.kind === "interface"
                ? { id: trace.id, name: traceName(trace) }
                : null
            }
            onOpenChange={(o) => !o && setTrace(null)}
          />
          <CableTraceDialog
            target={
              trace?.kind === "cable"
                ? { id: trace.id, label: traceName(trace) }
                : null
            }
            onOpenChange={(o) => !o && setTrace(null)}
          />
        </>
      )}
    </div>
  )
}

/** A traced port as the dialog's title names it: `device:port`. */
function traceName(t: PortTrace): string {
  return t.device ? `${t.device}:${t.name}` : t.name
}

/** One empty-unit band: hover Add/Assign affordances, and - when the
 * elevation is draggable - a drop target whose unit becomes the dragged
 * device's top row. */
/** One rail lane flanking the U grid: the side-mounted 0U strips (vertical
 * PDUs) that hang on that rail, plus "+" to hang a new one. Vertical text -
 * the lane is a strip, and so is the gear on it. */
function SideLane({
  side,
  devices,
  rackId,
  canAdd,
  onAssign,
}: {
  side: "side_left" | "side_right"
  devices: Device[]
  rackId: string
  canAdd: boolean
  /** Opens the "assign an existing 0U device" dialog for this rail. */
  onAssign?: () => void
}) {
  const railName = side === "side_left" ? "left" : "right"
  return (
    <div className="flex w-7 shrink-0 flex-col gap-1">
      {devices.map((d) => (
        <Link
          key={d.id}
          to="/devices/$id"
          params={{ id: d.id }}
          title={`${d.name} - ${railName} rail (0U)`}
          className="flex min-h-16 flex-1 items-center justify-center rounded border border-border bg-muted/60 hover:border-primary"
          style={{ writingMode: "vertical-rl" }}
        >
          <span className="max-h-full truncate px-0.5 py-1 font-mono text-[10px]">
            {d.name}
          </span>
        </Link>
      ))}
      {canAdd && (
        <Link
          to="/devices/new"
          search={{ rack: rackId, mount: side }}
          title={`Add a side-mounted 0U device (${railName} rail)`}
          className="flex h-7 items-center justify-center rounded border border-dashed border-border text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
        >
          +
        </Link>
      )}
      {onAssign && (
        <button
          type="button"
          onClick={onAssign}
          title={`Assign an existing 0U device (${railName} rail)`}
          className="flex h-7 items-center justify-center rounded border border-dashed border-border text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
        >
          ⇥
        </button>
      )}
    </div>
  )
}

function UnitBand({
  unit,
  row,
  droppable,
  onPick,
  onEnter,
  children,
}: {
  unit: number
  row: number
  droppable: boolean
  /** The device form's picker: a press on the unit. */
  onPick?: () => void
  /** The device form's picker: the pointer comes onto the unit. */
  onEnter?: () => void
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: String(unit),
    disabled: !droppable,
  })
  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      data-unit={unit}
      onClick={onPick}
      onPointerEnter={onEnter}
      className={cn(
        "group/unit flex items-center gap-2 border-b border-border/60 bg-muted/30 px-2 last:border-b-0",
        onPick && "cursor-pointer",
        isOver && "bg-primary/15 outline-1 outline-primary/50"
      )}
      style={{ gridRow: row, gridColumn: "1 / -1" }}
    >
      {children}
    </div>
  )
}

/** Hang an existing 0U device on a rail - the "assign" affordance in the side
 * lane. PATCHes the device's rack + mount (clearing any U position), the
 * mirror of AssignDeviceDialog for the zero-U case. */
function SideAssignDialog({
  rack,
  side,
  onOpenChange,
}: {
  rack: Rack
  side: "side_left" | "side_right" | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const railName = side === "side_left" ? "left" : "right"

  const assign = useMutation({
    mutationFn: () =>
      api<Device>(`/api/devices/${deviceId}/`, {
        method: "PATCH",
        body: JSON.stringify({ rack_id: rack.id, mount: side, position: null }),
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["rack-devices", rack.id] })
      qc.invalidateQueries({ queryKey: ["rack", rack.id] })
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["device", d.id] })
      toast.success(`${d.name} hung on the ${railName} rail`)
      setDeviceId(null)
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog
      open={side != null}
      onOpenChange={(o) => {
        if (!o) setDeviceId(null)
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign a 0U device to the {railName} rail</DialogTitle>
          <DialogDescription>
            Hangs an existing zero-U device (a vertical PDU or the like) on this
            rail of {rack.name}. Only zero-U device types can side-mount.
          </DialogDescription>
        </DialogHeader>
        <DevicePicker value={deviceId} onChange={setDeviceId} />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={!deviceId || assign.isPending}
          >
            {assign.isPending ? "Assigning…" : "Assign"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Put an existing device into a specific rack unit - the "Assign" hover
 * action on an empty band. PATCHes the device's rack/position/face. */
function AssignDeviceDialog({
  rack,
  unit,
  face,
  onOpenChange,
}: {
  rack: Rack
  unit: number | null
  face: RackFace
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [deviceId, setDeviceId] = useState<string | null>(null)
  // Half-width types need to say which half of the U they occupy - without
  // this the Assign path simply couldn't place them.
  const [rackSide, setRackSide] = useState<"left" | "right">("left")
  const picked = useQuery({
    queryKey: ["device", deviceId],
    queryFn: () => api<Device>(`/api/devices/${deviceId}/`),
    enabled: !!deviceId,
    staleTime: 30_000,
  })
  const halfWidth = picked.data?.device_type?.rack_width === "half"

  const assign = useMutation({
    mutationFn: () =>
      api<Device>(`/api/devices/${deviceId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          rack_id: rack.id,
          position: unit,
          face,
          rack_side: halfWidth ? rackSide : "",
        }),
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["rack-devices", rack.id] })
      qc.invalidateQueries({ queryKey: ["rack", rack.id] })
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["device", d.id] })
      toast.success(`${d.name} mounted at U${unit} (${face})`)
      setDeviceId(null)
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog
      open={unit != null}
      onOpenChange={(o) => {
        if (!o) setDeviceId(null)
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Assign a device to U{unit} · {face}
          </DialogTitle>
          <DialogDescription>
            Mounts an existing device in {rack.name} at this position. Its
            current placement (if any) moves here.
          </DialogDescription>
        </DialogHeader>
        <DevicePicker value={deviceId} onChange={setDeviceId} />
        {halfWidth && (
          <SegmentedTabs
            value={rackSide}
            onValueChange={(v) => setRackSide(v as "left" | "right")}
            items={[
              { value: "left", label: "Left half" },
              { value: "right", label: "Right half" },
            ]}
          />
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={!deviceId || assign.isPending}
          >
            {assign.isPending ? "Assigning…" : "Assign"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DeviceBlock({
  device,
  face,
  mode,
  view,
  highlight,
  showText,
  startRow,
  span,
  column,
  accent,
  dragEnabled = false,
  inert = false,
  live = false,
  ports,
  countVirtual = false,
}: {
  device: Device
  face: RackFace
  mode: RackDisplayMode
  /** Its front where it is mounted, its other side where it is full depth,
   * or hatched space the Show filter leaves it out of. */
  view: BlockView
  /** A live face lies over this block (`RackLiveFace`). On the face it is
   * mounted on the face draws the picture and the text; on its other side
   * the block keeps its hatching under it, for a type with no plate there. */
  live?: boolean
  /** The device's counted ports - its block shows those in use over them. */
  ports?: PortCountRow
  /** The deployment counts virtual interfaces too (the badge says so). */
  countVirtual?: boolean
  /** Rack page: this block can be dragged to another unit. */
  dragEnabled?: boolean
  /** The device form's picker: a picture, not a link - a press goes through
   * to the unit under it. */
  inert?: boolean
  highlight: boolean
  /** Overlay position + name on image/render blocks (names mode: always). */
  showText: boolean
  startRow: number
  span: number
  /** CSS grid-column - "1 / -1" full width, "1"/"2" for half-width halves. */
  column: string
  accent?: string
}) {
  const mountedOn: RackFace = device.face === "rear" ? "rear" : "front"
  const own = view === "own"
  const hidden = view === "hidden"
  const overlaid = own && live
  // The other side's plate, where nothing live lies over it: Images, the
  // type's rear photo; Render, the type's drawing of its rear. Names draws
  // the other side as a plain block.
  const rearDoc = useSavedFaceplate(
    view === "other" && mode === "render" && !live
      ? device.device_type?.id
      : null
  )
  const otherPlate =
    mode === "names" ||
    (!live &&
      (mode === "images"
        ? !!device.device_type?.rear_image
        : (rearDoc?.rear.length ?? 0) > 0))
  // Hatched: hidden by the Show filter, or the other side of a type with no
  // plate for it - never an empty plain block.
  const hatched = hidden || (view === "other" && !otherPlate)
  // Images mode: paint the type's rack-face image across the block with a
  // legibility scrim. Render mode: draw the type's faceplate at rack scale.
  // The device's own face shows its front - front_image - and its other
  // side its rear - rear_image. (Keying off the elevation `face` alone showed
  // rear-mounted devices' rear image on the rear elevation.)
  const image =
    mode === "images" && !hatched && !overlaid
      ? face === mountedOn
        ? device.device_type?.front_image
        : device.device_type?.rear_image
      : null
  const renderPanel =
    mode === "render" && !hatched && !overlaid && device.device_type
  const text = !overlaid && !hidden && (mode === "names" || hatched || showText)
  // Occupied units fill edge-to-edge (square corners) and take
  // the DEVICE ROLE's color as the block background in names mode.
  const roleColor =
    !hatched && !image && !renderPanel && !overlaid
      ? device.role?.color || null
      : null
  const roleFg = roleColor ? readableText(roleColor) : undefined

  const drag = useDraggable({ id: device.id, disabled: !dragEnabled })

  const className = cn(
    "group/dev relative z-10 flex items-center gap-2 overflow-hidden border px-2",
    dragEnabled && "touch-none",
    drag.isDragging && "opacity-40",
    hatched
      ? "border-border/60 bg-transparent hover:bg-muted/40"
      : "border-border hover:brightness-110",
    image ? "bg-zinc-950" : hatched || roleColor ? "" : "bg-card",
    highlight && "z-20 border-primary ring-2 ring-primary/50"
  )
  const style = {
    gridColumn: column,
    gridRow: `${Math.max(1, startRow)} / span ${span}`,
    backgroundColor: roleColor ?? undefined,
    color: roleFg,
    borderLeft:
      accent && !hatched && !roleColor ? `3px solid ${accent}` : undefined,
    // Diagonal stripes: units this face can't use - a full-depth device's
    // other side with no plate, or gear the Show filter leaves out.
    backgroundImage: hatched
      ? "repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in srgb, currentColor 18%, transparent) 5px, color-mix(in srgb, currentColor 18%, transparent) 7px)"
      : undefined,
  }
  const content = (
    <>
      {image && (
        <>
          <img
            src={image}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full object-fill"
          />
          {/* Legibility scrim so the overlaid name stays readable. */}
          {text && (
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/70 via-black/30 to-transparent" />
          )}
        </>
      )}
      {renderPanel && (
        // Fills the block minus the position rail - TypeFaceplate scales down
        // to the available width, so every port stays visible.
        <div className="pointer-events-none absolute inset-y-0 right-1 left-7 flex items-center">
          <TypeFaceplate
            deviceTypeId={device.device_type!.id}
            side={face === mountedOn ? "front" : "rear"}
            pxPerMm={RENDER_PX_PER_MM}
            vcPosition={device.vc_position}
            compact
          />
        </div>
      )}
      {!overlaid && !hidden && (text || (!image && !renderPanel)) && (
        <>
          <span
            className={cn(
              "relative w-6 shrink-0 text-right font-mono text-[10px] tabular-nums",
              image
                ? "text-zinc-300"
                : roleColor
                  ? "opacity-80"
                  : "text-muted-foreground"
            )}
          >
            {device.position}
          </span>
          {!renderPanel && (
            <span
              className={cn(
                "relative truncate text-[12px] font-medium",
                image
                  ? "text-white"
                  : hatched
                    ? "text-muted-foreground"
                    : roleColor
                      ? ""
                      : "text-foreground"
              )}
            >
              {device.name}
            </span>
          )}
          {renderPanel && (
            <span className="relative z-10 max-w-[40%] truncate rounded bg-background/75 px-1 text-[10px] font-medium">
              {device.name}
            </span>
          )}
          {own && (
            <PortsBadge
              ports={ports}
              countVirtual={countVirtual}
              className="relative ml-auto"
            />
          )}
          {device.u_height > 1 && !renderPanel && (
            <span
              className={cn(
                "relative shrink-0 text-[10px] tabular-nums",
                // After the ports badge when there is one.
                !(own && ports?.total) && "ml-auto",
                image
                  ? "text-zinc-300"
                  : roleColor
                    ? "opacity-80"
                    : "text-muted-foreground"
              )}
            >
              {device.u_height}U
            </span>
          )}
        </>
      )}
    </>
  )
  if (inert)
    return (
      <div
        data-device={device.name}
        className={cn(className, "pointer-events-none")}
        style={style}
      >
        {content}
      </div>
    )
  // Left out by the Show filter: the space it takes, and nothing to open.
  if (hidden)
    return (
      <div
        aria-hidden
        data-device={device.name}
        data-view="hidden"
        className={className}
        style={style}
      />
    )

  return (
    <Link
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      to="/devices/$id"
      params={{ id: device.id }}
      data-view={view}
      className={className}
      style={style}
      title={`${device.name} · U${device.position}${
        device.u_height > 1
          ? `–U${(device.position as number) + device.u_height - 1}`
          : ""
      }${device.rack_width === "half" ? ` · ${device.rack_side || "left"} half` : ""}${
        own ? "" : ` · mounted on ${mountedOn}`
      }`}
    >
      {content}
    </Link>
  )
}
