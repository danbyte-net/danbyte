import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  Device,
  DeviceType,
  DinRail,
  FacePorts,
  Interface,
  Paginated,
} from "@/lib/api"
import { deviceBody } from "@/lib/din-geometry"
import type { PlateBox } from "@/lib/photo-calibration"
import { cn } from "@/lib/utils"
import {
  calibratedPhotos,
  frontPhoto,
  nameLayout,
  usePhotoAspects,
} from "@/components/cabinet-devices"
import {
  FaceplateView,
  PortTraceProvider,
  TypeFaceplate,
  useObservedPorts,
  useSavedFaceplate,
} from "@/components/device-faceplate"
import type { PortComponent } from "@/lib/faceplate-layout"
import type { PortTrace } from "@/components/device-faceplate"
import type { LegendReporter } from "@/components/speed-scale"

// The cabinet plate's live faces (#277): each device's faceplate over its
// body - the device page's Panel, its ports coloured by cable and SNMP
// state, with their hover cards, and a cabled port's run traced on a click.
// Render lays one on every device; Images only on a device whose photo has
// ports marked on it, as the rack's elevation does (#248). The faceplates
// are HTML (router links, hover cards, the schematic's lanes of cages), so
// they are laid over the plate's SVG rather than drawn in it: boxes placed
// in the plate's millimetres at the drawing's zoom, so each sits exactly on
// its body.

/** The drawing's frame: where its viewBox starts, plate mm, and its zoom,
 * screen px per mm. */
export interface PlateFrame {
  x: number
  y: number
  pxPerMm: number
}

/** A plate box as CSS pixels within the drawing. */
function place(b: PlateBox, f: PlateFrame): CSSProperties {
  return {
    left: (b.x - f.x) * f.pxPerMm,
    top: (b.y - f.y) * f.pxPerMm,
    width: b.width * f.pxPerMm,
    height: b.height * f.pxPerMm,
  }
}

/** The layer itself lets presses through to the bodies under it - a press
 * between ports opens the device, as in the other modes; the ports, their
 * hover cards and the panel's buttons take their own. The rack elevation's
 * live faces (#248) lie over their blocks the same way. */
export const LIVE =
  "[&_a]:pointer-events-auto [&_button]:pointer-events-auto **:data-[slot=hover-card-trigger]:pointer-events-auto"

/**
 * The photo-port markers of a cabinet's devices resolved to their ports, in
 * one bulk request: `/api/devices/face-ports/` for every device with a
 * front photo, without SNMP drift - as the rack page's port state - so it
 * costs the same few queries for one device or all of them.
 */
export function useCabinetFacePorts(devices: Device[], enabled: boolean) {
  const ids = useMemo(
    () =>
      devices
        .filter((d) => d.device_type?.front_image)
        .map((d) => d.id)
        .sort()
        // The endpoint's limit; no cabinet comes near it.
        .slice(0, 200),
    [devices]
  )
  return useQuery({
    queryKey: ["cabinet-face-ports", ids.join(",")],
    queryFn: () =>
      api<Record<string, FacePorts>>(
        `/api/devices/face-ports/?ids=${ids.join(",")}`
      ),
    enabled: enabled && ids.length > 0,
    staleTime: 30_000,
  })
}

/**
 * The devices' faceplates over the plate, for the drawing's `relative`
 * wrapper. A type with photo ports shows its photo with the ports marked on
 * it - at its true size where the photo is calibrated, its markers where
 * they are on the photo, else stretched to the body as Images draws it. In
 * Render a type without draws its schematic faceplate, shrunk into the body
 * where it is larger; in Images it keeps its plain photo, drawn under it. A
 * device with neither keeps the body drawn under it.
 *
 * Images reads every device's markers from one bulk request and asks
 * nothing per device for them; the interfaces the markers stand for load
 * per device, as Render loads them, and SNMP state only for a face that
 * draws interfaces. A press on a cabled port goes to `onTrace`.
 *
 * With `live` off (the Ports tick) there is no live state: Render draws
 * each type's plain drawing, as the rack's elevation does, and Images
 * nothing over the bodies' photos.
 */
export function CabinetFaceplates({
  rails,
  devices,
  frame,
  mode = "render",
  labels,
  onLegend,
  onLive,
  onTrace,
  live = true,
}: {
  rails: DinRail[]
  devices: Device[]
  frame: PlateFrame
  /** Render: every device's face. Images: the photos with ports marked. */
  mode?: "images" | "render"
  /** Write each device's name across its top, as Images does. */
  labels: boolean
  /** Report the colours each faceplate draws, keyed by device. */
  onLegend?: LegendReporter
  /** Whether a device's ports carry live SNMP facts. */
  onLive?: (deviceId: string, live: boolean) => void
  /** A cabled port pressed: its run, to trace. */
  onTrace?: (t: PortTrace) => void
  /** Off: no live state - Render draws each type's plain drawing. */
  live?: boolean
}) {
  const railById = new Map(rails.map((r) => [r.id, r]))
  const aspects = usePhotoAspects(calibratedPhotos(devices))
  const bulk = useCabinetFacePorts(devices, live && mode === "images")
  if (!live && mode === "images") return null
  return (
    <PortTraceProvider onTrace={onTrace ?? null}>
      <div
        data-part="faceplates"
        className="pointer-events-none absolute inset-0"
      >
        {devices.map((d) => {
          const rail = d.din_rail ? railById.get(d.din_rail.id) : undefined
          const body = rail
            ? deviceBody(rail, d.din_offset_mm, d.device_type)
            : null
          if (!rail || !body || !d.device_type) return null
          if (!live)
            return (
              <PlainFace
                key={d.id}
                device={d}
                typeId={d.device_type.id}
                body={body}
                frame={frame}
                labels={labels}
              />
            )
          return (
            <DeviceFace
              key={d.id}
              device={d}
              typeId={d.device_type.id}
              body={body}
              photo={frontPhoto(d, rail, body, aspects)}
              frame={frame}
              mode={mode}
              facePorts={mode === "images" ? bulk.data?.[d.id] : undefined}
              labels={labels}
              onLegend={onLegend}
              onLive={onLive}
            />
          )
        })}
      </div>
    </PortTraceProvider>
  )
}

function DeviceFace({
  device: d,
  typeId,
  body,
  photo,
  frame,
  mode,
  facePorts,
  labels,
  onLegend,
  onLive,
}: {
  device: Device
  typeId: string
  body: PlateBox
  photo: ReturnType<typeof frontPhoto>
  frame: PlateFrame
  mode: "images" | "render"
  /** Images: this device's markers, from the plate's one bulk request. */
  facePorts?: FacePorts
  labels: boolean
  onLegend?: LegendReporter
  onLive?: (deviceId: string, live: boolean) => void
}) {
  // The same requests, and caches, as the device page's Panel.
  const type = useQuery({
    queryKey: ["device-type", typeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${typeId}/`),
    staleTime: 5 * 60_000,
  })
  // A photo with ports marked on it is what Images draws live; Render draws
  // every device.
  const marked = type.data?.image_ports
  const photoPorts =
    !!photo && !!marked && marked.front.length + marked.rear.length > 0
  const images = mode === "images"
  const ifaces = useQuery({
    queryKey: ["device-interfaces", d.id],
    queryFn: () =>
      api<Paginated<Interface>>(`/api/devices/${d.id}/interfaces/`),
    enabled: !images || photoPorts,
  })
  // Images asks SNMP only for a photo that marks interfaces - the device's
  // own markers where it has them, as the panel reads them.
  const markers = (d.image_ports ?? marked)?.front ?? []
  const observed = useObservedPorts(
    !images ||
      (photoPorts &&
        markers.some((m) => (m.kind || "interface") === "interface"))
      ? d.id
      : undefined
  )
  const live = !!observed
  useEffect(() => {
    if (!onLive) return
    onLive(d.id, live)
    return () => onLive(d.id, false)
  }, [onLive, d.id, live])
  const physical = useMemo(
    () => (ifaces.data?.results ?? []).filter((i) => !i.virtual),
    [ifaces.data]
  )
  // Until both are in, the body drawn under this one shows. Images draws
  // only a photo with ports, and waits for the plate's bulk markers rather
  // than asking for its own.
  if (!type.data || ifaces.isPending) return null
  if (images && (!photoPorts || !facePorts)) return null

  const z = frame.pxPerMm
  const label = labels
    ? nameLayout(d.name, body.width * z, body.height * z, true)
    : null
  const shared = {
    deviceTypeId: typeId,
    deviceId: d.id,
    interfaces: physical,
    vcPosition: d.vc_position,
    side: "front" as const,
    observed,
    onLegend,
    legendKey: d.id,
    portLabels: d.port_labels,
    // Images hands the panel what it would otherwise ask for per device:
    // its markers and its own record.
    ...(images ? { facePorts, device: d } : {}),
  }
  const outline = (
    <div className="pointer-events-none absolute inset-0 border border-border" />
  )

  // Photo ports: what the device page's Panel draws as Photo.
  if (photo && photoPorts) {
    const at = photo.calibrated ? photo.box : body
    if (!at) return null
    return (
      <div
        data-face={d.name}
        data-look="photo"
        className={cn("absolute overflow-hidden", LIVE)}
        style={place(body, frame)}
      >
        <div
          className="absolute"
          style={{
            left: (at.x - body.x) * z,
            top: (at.y - body.y) * z,
            width: at.width * z,
            height: at.height * z,
          }}
        >
          <FaceplateView mode="image" fill {...shared} />
        </div>
        {label && <NameStrip text={label.text} className="absolute" />}
        {outline}
      </div>
    )
  }

  if (physical.length === 0) return null
  return (
    <div
      data-face={d.name}
      data-look="schematic"
      className={cn("absolute flex flex-col overflow-hidden bg-card", LIVE)}
      style={place(body, frame)}
    >
      {label && <NameStrip text={label.text} className="shrink-0" />}
      <FitInBox className="min-h-0 flex-1">
        <FaceplateView
          mode="rendered"
          fit={z}
          className="border-0 bg-transparent"
          {...shared}
        />
      </FitInBox>
      {outline}
    </div>
  )
}

/** A device's type drawn plain over its body - Render with the live ports
 * off: the type's faceplate from its templates, no state, nothing to press.
 * A type with nothing to draw leaves the body under it. */
function PlainFace({
  device: d,
  typeId,
  body,
  frame,
  labels,
}: {
  device: Device
  typeId: string
  body: PlateBox
  frame: PlateFrame
  labels: boolean
}) {
  // What TypeFaceplate draws from, in its own caches: the saved layout, or
  // the automatic one from the interface templates.
  const saved = useSavedFaceplate(typeId)
  const templates = useQuery({
    queryKey: ["dt-interface-templates", typeId],
    queryFn: () =>
      api<Paginated<PortComponent>>(
        `/api/interface-templates/?device_type=${typeId}`
      ),
    staleTime: 5 * 60_000,
  })
  const draws = !!saved?.front.length || !!templates.data?.results.length
  if (!draws) return null
  const z = frame.pxPerMm
  const label = labels
    ? nameLayout(d.name, body.width * z, body.height * z, true)
    : null
  return (
    <div
      data-face={d.name}
      data-look="plain"
      className="absolute flex flex-col overflow-hidden bg-card"
      style={place(body, frame)}
    >
      {label && <NameStrip text={label.text} className="shrink-0" />}
      <div className="flex min-h-0 flex-1 items-center px-1">
        <TypeFaceplate
          deviceTypeId={typeId}
          pxPerMm={z}
          vcPosition={d.vc_position}
          compact
        />
      </div>
      <div className="pointer-events-none absolute inset-0 border border-border" />
    </div>
  )
}

/** The name across a body's top, on the strip Images writes it on. */
function NameStrip({ text, className }: { text: string; className?: string }) {
  return (
    <div
      data-part="name"
      className={cn(
        "pointer-events-none inset-x-0 top-0 flex h-4 items-center justify-center bg-background/85 text-[10px] leading-none font-medium whitespace-nowrap text-foreground",
        className
      )}
    >
      {text}
    </div>
  )
}

/** Its child at its own size, centred - shrunk to fit where it is larger
 * than the box. */
export function FitInBox({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(1)
  useLayoutEffect(() => {
    const box = outer.current
    const content = inner.current
    if (!box || !content) return
    const fit = () => {
      const w = content.offsetWidth
      const h = content.offsetHeight
      const next =
        w > 0 && h > 0
          ? Math.min(1, box.clientWidth / w, box.clientHeight / h)
          : 1
      setK((cur) => (Math.abs(cur - next) < 0.001 ? cur : next))
    }
    fit()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    ro.observe(content)
    return () => ro.disconnect()
  }, [])
  return (
    <div
      ref={outer}
      className={cn(
        "flex items-center justify-center overflow-hidden",
        className
      )}
    >
      <div
        ref={inner}
        data-part="fit"
        className="w-max shrink-0"
        style={k < 1 ? { transform: `scale(${k})` } : undefined}
      >
        {children}
      </div>
    </div>
  )
}
