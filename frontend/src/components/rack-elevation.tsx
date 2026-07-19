import { useMemo, useState } from "react"
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

import { api, type Device, type Paginated, type Rack } from "@/lib/api"
import { readableText } from "@/components/cells/color-badge"
import { PANEL_MM } from "@/lib/faceplate-geometry"
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
import { TypeFaceplate } from "@/components/device-faceplate"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { apiErrorToast } from "@/lib/api-toast"

// Every mode draws mm-true rows so switching modes never resizes the rack:
// Names/Images share one scale (19″ → ~430px wide, ~42px per U); Render is
// larger so individual ports stay legible.
const BASE_PX_PER_MM = 0.95
const RENDER_PX_PER_MM = 1.35

// Usable opening (mm) per rack width — 19″ is EIA-310's 450mm; the rest scale
// with the rail spacing (10″ half-racks, 21/23″ telco).
const OPENING_MM: Record<number, number> = {
  10: 222,
  19: 450,
  21: 500,
  23: 551,
}

export type RackFace = "front" | "rear"
export type RackDisplayMode = "names" | "images" | "render"

export function RackElevation({
  rack,
  face: controlledFace,
  mode: controlledMode,
  labels: controlledLabels,
  highlightDeviceId,
  showHeader = true,
  scale,
  draggable = false,
}: {
  rack: Rack
  /** Controlled face — hides the internal Front/Rear toggle. */
  face?: RackFace
  /** Controlled display mode — hides the internal mode toggle. */
  mode?: RackDisplayMode
  /** Overlay names on image/render blocks (controlled — hides the tick). */
  labels?: boolean
  /** Ring the matching device block (e.g. on its own detail page). */
  highlightDeviceId?: string
  showHeader?: boolean
  /** px per mm — bump for hero contexts (rack detail page). Render mode
   * never drops below its own minimum so ports stay legible. */
  scale?: number
  /** Rack page: drag device blocks between units to re-position them. */
  draggable?: boolean
}) {
  const [faceState, setFace] = useState<RackFace>("front")
  const [modeState, setMode] = useState<RackDisplayMode>("names")
  const [labelsState, setLabels] = useState(true)
  const [assignUnit, setAssignUnit] = useState<number | null>(null)
  const { canDo } = useMe()
  const canAddDevice = canDo("device", "add")
  const canMoveDevice = canDo("device", "change")
  const canDrag = draggable && canMoveDevice
  const qc = useQueryClient()
  const [dragging, setDragging] = useState<Device | null>(null)
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
  const rowOf = (unit: number) =>
    rack.desc_units
      ? unit - rack.starting_unit + 1
      : rack.starting_unit + rack.u_height - 1 - unit + 1

  const devices = q.data?.results ?? []
  // NetBox semantics: a device mounts on ONE face (face "" ≈ front); when its
  // type is full-depth it *occupies* the opposite face too — drawn hatched
  // there, so the rear view shows what's blocking the space.
  const visible = useMemo(
    () =>
      devices
        .filter((d) => d.position != null)
        .map((d) => {
          const mounted: RackFace = d.face === "rear" ? "rear" : "front"
          const fullDepth = d.device_type?.is_full_depth ?? true
          if (mounted === face) return { d, hatched: false }
          if (fullDepth) return { d, hatched: true }
          return null
        })
        .filter((x): x is { d: Device; hatched: boolean } => x !== null),
    [devices, face]
  )

  // Proportions: mm-true rows at widths that follow the rack's physical
  // opening (a real 1U blade is ~10:1 — squeezing it into short rows is what
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
      toast.error("Doesn't fit there — runs past the rack.")
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
            <div
              className="relative grid"
              style={{
                gridTemplateRows: `repeat(${rack.u_height}, ${rowHeight}px)`,
                // Two columns so half-width devices (rack_width="half") can sit
                // side by side in one U; full-width blocks span both.
                gridTemplateColumns: "1fr 1fr",
                minWidth: gridMinWidth,
              }}
            >
              {/* Empty "available" bands — one per unit. Devices overlay on
                top, so these hover affordances only surface on free space. */}
              {units.map((unit, i) => (
                <UnitBand
                  key={unit}
                  unit={unit}
                  row={i + 1}
                  droppable={canDrag}
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
                          className="rounded px-1 text-[10px] font-medium text-primary hover:underline"
                        >
                          + Add
                        </Link>
                      )}
                      {canMoveDevice && (
                        <button
                          type="button"
                          onClick={() => setAssignUnit(unit)}
                          className="rounded px-1 text-[10px] font-medium text-primary hover:underline"
                        >
                          Assign
                        </button>
                      )}
                    </span>
                  )}
                </UnitBand>
              ))}

              {/* Device blocks spanning their u_height. */}
              {visible.map(({ d, hatched }) => {
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
                return (
                  <DeviceBlock
                    key={d.id}
                    device={d}
                    face={face}
                    mode={mode}
                    hatched={hatched}
                    dragEnabled={canDrag && !hatched}
                    highlight={d.id === highlightDeviceId}
                    showText={labels}
                    startRow={top}
                    // span clamps to the visible grid in case of overflow
                    span={Math.max(1, d.u_height)}
                    column={column}
                    accent={rack.role?.color || undefined}
                  />
                )
              })}
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

      {q.isLoading && (
        <p className="mt-2 text-xs text-muted-foreground">Loading devices…</p>
      )}

      <AssignDeviceDialog
        rack={rack}
        unit={assignUnit}
        face={face}
        onOpenChange={(o) => !o && setAssignUnit(null)}
      />
    </div>
  )
}

/** One empty-unit band: hover Add/Assign affordances, and — when the
 * elevation is draggable — a drop target whose unit becomes the dragged
 * device's top row. */
function UnitBand({
  unit,
  row,
  droppable,
  children,
}: {
  unit: number
  row: number
  droppable: boolean
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: String(unit),
    disabled: !droppable,
  })
  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      className={cn(
        "group/unit flex items-center gap-2 border-b border-border/60 bg-muted/30 px-2 last:border-b-0",
        isOver && "bg-primary/15 outline-1 outline-primary/50"
      )}
      style={{ gridRow: row, gridColumn: "1 / -1" }}
    >
      {children}
    </div>
  )
}

/** Put an existing device into a specific rack unit — the "Assign" hover
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

  const assign = useMutation({
    mutationFn: () =>
      api<Device>(`/api/devices/${deviceId}/`, {
        method: "PATCH",
        body: JSON.stringify({ rack_id: rack.id, position: unit, face }),
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
  hatched,
  highlight,
  showText,
  startRow,
  span,
  column,
  accent,
  dragEnabled = false,
}: {
  device: Device
  face: RackFace
  mode: RackDisplayMode
  /** Rack page: this block can be dragged to another unit. */
  dragEnabled?: boolean
  /** Occupied from the other face (full-depth) — striped, muted. */
  hatched: boolean
  highlight: boolean
  /** Overlay position + name on image/render blocks (names mode: always). */
  showText: boolean
  startRow: number
  span: number
  /** CSS grid-column — "1 / -1" full width, "1"/"2" for half-width halves. */
  column: string
  accent?: string
}) {
  const mountedOn: RackFace = device.face === "rear" ? "rear" : "front"
  // Images mode: paint the type's rack-face image across the block with a
  // legibility scrim. Render mode: draw the type's faceplate at rack scale.
  // A non-hatched block is drawn on the device's OWN mounted face, so you're
  // looking at its front — use front_image there, rear_image only on the
  // opposite face. (Keying off the elevation `face` alone showed rear-mounted
  // devices' rear image on the rear elevation.)
  const image =
    mode === "images" && !hatched
      ? face === mountedOn
        ? device.device_type?.front_image
        : device.device_type?.rear_image
      : null
  const renderPanel = mode === "render" && !hatched && device.device_type
  const text = mode === "names" || hatched || showText
  // NetBox-style: occupied units fill edge-to-edge (square corners) and take
  // the DEVICE ROLE's color as the block background in names mode.
  const roleColor =
    !hatched && !image && !renderPanel ? device.role?.color || null : null
  const roleFg = roleColor ? readableText(roleColor) : undefined

  const drag = useDraggable({ id: device.id, disabled: !dragEnabled })

  return (
    <Link
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      to="/devices/$id"
      params={{ id: device.id }}
      className={cn(
        "group/dev relative z-10 flex items-center gap-2 overflow-hidden border px-2",
        dragEnabled && "touch-none",
        drag.isDragging && "opacity-40",
        hatched
          ? "border-border/60 bg-transparent hover:bg-muted/40"
          : "border-border hover:brightness-110",
        image ? "bg-zinc-950" : hatched || roleColor ? "" : "bg-card",
        highlight && "z-20 border-primary ring-2 ring-primary/50"
      )}
      style={{
        gridColumn: column,
        gridRow: `${Math.max(1, startRow)} / span ${span}`,
        backgroundColor: roleColor ?? undefined,
        color: roleFg,
        borderLeft:
          accent && !hatched && !roleColor ? `3px solid ${accent}` : undefined,
        // NetBox-style diagonal stripes: this face is blocked by a full-depth
        // device mounted on the other face.
        backgroundImage: hatched
          ? "repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in srgb, currentColor 18%, transparent) 5px, color-mix(in srgb, currentColor 18%, transparent) 7px)"
          : undefined,
      }}
      title={`${device.name} · U${device.position}${
        device.u_height > 1
          ? `–U${(device.position as number) + device.u_height - 1}`
          : ""
      }${device.rack_width === "half" ? ` · ${device.rack_side || "left"} half` : ""}${
        hatched ? ` · mounted on ${mountedOn}` : ""
      }`}
    >
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
        // Fills the block minus the position rail — TypeFaceplate scales down
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
      {(text || (!image && !renderPanel)) && (
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
          {device.u_height > 1 && !renderPanel && (
            <span
              className={cn(
                "relative ml-auto shrink-0 text-[10px] tabular-nums",
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
    </Link>
  )
}
