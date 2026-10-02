import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  Device,
  DeviceType,
  DinRail,
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
import { FaceplateView, useObservedPorts } from "@/components/device-faceplate"
import type { LegendReporter } from "@/components/speed-scale"

// The cabinet plate's Render mode (#277): each device's live faceplate over
// its body - the device page's Panel, its ports coloured by cable and SNMP
// state, with their hover cards and a click through to the port. The
// faceplates are HTML (router links, hover cards, the schematic's lanes of
// cages), so they are laid over the plate's SVG rather than drawn in it:
// boxes placed in the plate's millimetres at the drawing's zoom, so each
// sits exactly on its body.

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
 * hover cards and the panel's buttons take their own. */
const LIVE =
  "[&_a]:pointer-events-auto [&_button]:pointer-events-auto **:data-[slot=hover-card-trigger]:pointer-events-auto"

/**
 * The devices' faceplates over the plate, for the drawing's `relative`
 * wrapper. A type with photo ports shows its photo with the ports marked on
 * it - at its true size where the photo is calibrated, its markers where
 * they are on the photo, else stretched to the body as Images draws it. A
 * type without draws its schematic faceplate, shrunk into the body where it
 * is larger. A device with neither keeps the body drawn under it.
 */
export function CabinetFaceplates({
  rails,
  devices,
  frame,
  labels,
  onLegend,
  onLive,
}: {
  rails: DinRail[]
  devices: Device[]
  frame: PlateFrame
  /** Write each device's name across its top, as Images does. */
  labels: boolean
  /** Report the colours each faceplate draws, keyed by device. */
  onLegend?: LegendReporter
  /** Whether a device's ports carry live SNMP facts. */
  onLive?: (deviceId: string, live: boolean) => void
}) {
  const railById = new Map(rails.map((r) => [r.id, r]))
  const aspects = usePhotoAspects(calibratedPhotos(devices))
  return (
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
        return (
          <DeviceFace
            key={d.id}
            device={d}
            typeId={d.device_type.id}
            body={body}
            photo={frontPhoto(d, rail, body, aspects)}
            frame={frame}
            labels={labels}
            onLegend={onLegend}
            onLive={onLive}
          />
        )
      })}
    </div>
  )
}

function DeviceFace({
  device: d,
  typeId,
  body,
  photo,
  frame,
  labels,
  onLegend,
  onLive,
}: {
  device: Device
  typeId: string
  body: PlateBox
  photo: ReturnType<typeof frontPhoto>
  frame: PlateFrame
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
  const ifaces = useQuery({
    queryKey: ["device-interfaces", d.id],
    queryFn: () =>
      api<Paginated<Interface>>(`/api/devices/${d.id}/interfaces/`),
  })
  const observed = useObservedPorts(d.id)
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
  // Until both are in, the body drawn under this one shows.
  if (!type.data || ifaces.isPending) return null

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
  }
  const outline = (
    <div className="pointer-events-none absolute inset-0 border border-border" />
  )

  // Photo ports: what the device page's Panel draws as Photo.
  const marked = type.data.image_ports
  if (photo && marked && marked.front.length + marked.rear.length > 0) {
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
function FitInBox({
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
