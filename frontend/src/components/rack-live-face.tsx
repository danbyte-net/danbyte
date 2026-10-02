import { useMemo } from "react"
import type { CSSProperties } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  Device,
  DeviceType,
  PortCountRow,
  RackPortDevice,
} from "@/lib/api"
import type { PortComponent, SlotKind } from "@/lib/faceplate-layout"
import { portsUsed, rackPortInterfaces } from "@/lib/rack-port-state"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { FitInBox, LIVE } from "@/components/cabinet-faceplates"
import {
  FaceplateView,
  PortTraceProvider,
  useObservedPorts,
} from "@/components/device-faceplate"
import type { PortTrace } from "@/components/device-faceplate"

/** A device's ports in use over its counted ports - `38 / 48` - on its
 * rack block. Nothing for a device with no counted ports. */
export function PortsBadge({
  ports,
  className,
}: {
  ports?: PortCountRow
  className?: string
}) {
  if (!ports?.total) return null
  return (
    <Badge
      variant="secondary"
      data-part="ports"
      className={cn("num h-4 px-1 text-[10px] leading-none", className)}
    >
      {portsUsed(ports)} / {ports.total}
      <span className="sr-only"> ports in use</span>
    </Badge>
  )
}

/**
 * A device's live face over its block on the rack page's elevation (#248):
 * the device page's panel, fed from the rack's one port-state request, so
 * the rack costs no request per device for it. A type with a photo and
 * ports marked on it shows the photo with its markers, as the device page
 * and the 3D room do; another draws its faceplate in Render mode and its
 * plain photo in Images. Ports wear the device page's colours - cable state,
 * speed, reserved, disabled, VLAN - with its hover card and live SNMP dots,
 * and a press on a cabled one goes to `onTrace` (`PortTraceProvider`).
 *
 * It lies over the block in the same grid cell: the block under it keeps
 * the link to the device, the drag and the frame, and only the ports and
 * their hover cards take the pointer (`LIVE`), as the cabinet's faces do.
 * The face draws the block's text - position, name, ports in use - as the
 * block would.
 */
export function RackLiveFace({
  device: d,
  state,
  mode,
  side,
  pxPerMm,
  text,
  onTrace,
  style,
  className,
}: {
  device: Device
  state: RackPortDevice
  mode: "images" | "render"
  /** The device's own face shown: front on the face it is mounted on. */
  side: "front" | "rear"
  /** The elevation's scale: the drawn faceplate's, shrunk to fit. */
  pxPerMm: number
  /** Write the position, name and ports in use over it. */
  text: boolean
  /** A cabled port pressed: its run, to trace. */
  onTrace?: (t: PortTrace) => void
  /** Its place in the elevation's grid - the block's own. */
  style: CSSProperties
  className?: string
}) {
  const typeId = d.device_type?.id
  // Shared by type with the device page and every other face of the type.
  const type = useQuery({
    queryKey: ["device-type", typeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${typeId}/`),
    enabled: !!typeId,
    staleTime: 5 * 60_000,
  })
  const interfaces = useMemo(
    () => rackPortInterfaces(d, state.interfaces),
    [d, state.interfaces]
  )
  const t = type.data
  const image =
    side === "front" ? d.device_type?.front_image : d.device_type?.rear_image
  // The device page's rule: the photo panel when the type has a photo and
  // ports marked on it - here only where this side has its photo.
  const marked = t?.image_ports
  const photo =
    !!image && !!marked && marked.front.length + marked.rear.length > 0
  // Null while the type loads (a typeless device draws its interfaces).
  const look: "photo" | "image" | "drawn" | null = photo
    ? "photo"
    : mode === "images"
      ? image
        ? "image"
        : null
      : t || !typeId
        ? "drawn"
        : null
  // Live SNMP only for a face that draws interface ports - not for a disk
  // shelf's photo, nor in Images for a type without photo ports.
  const markers = (d.image_ports ?? marked)?.[side] ?? []
  const drawsPorts =
    interfaces.length > 0 &&
    (look === "drawn" ||
      (look === "photo" &&
        markers.some((m) => (m.kind || "interface") === "interface")))
  const observed = useObservedPorts(drawsPorts ? d.id : undefined)

  const shared = {
    deviceTypeId: typeId,
    deviceId: d.id,
    interfaces,
    vcPosition: d.vc_position,
    side,
    observed,
    portLabels: d.port_labels,
    device: d,
    facePorts: state.face,
    modules: state.modules,
    components: state.components as Partial<Record<SlotKind, PortComponent[]>>,
  }
  const pictured = look === "photo" || look === "image"
  return (
    <PortTraceProvider onTrace={onTrace ?? null}>
      <div
        data-live-face={d.name}
        data-look={look ?? "none"}
        className={cn(
          "pointer-events-none relative z-20 overflow-hidden border border-transparent",
          pictured && "bg-zinc-950",
          LIVE,
          className
        )}
        style={style}
      >
        {look === "photo" && (
          <div className="absolute inset-0">
            <FaceplateView mode="image" fill {...shared} />
          </div>
        )}
        {look === "image" && (
          <img
            src={image ?? undefined}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-fill"
          />
        )}
        {look === "drawn" && (
          // The block's width less its position rail, as Render draws it, and
          // below the name strip, so the text never covers a port.
          <div
            className={cn(
              "absolute right-1 bottom-0 left-7",
              text ? "top-4" : "top-0"
            )}
          >
            <FitInBox className="h-full w-full justify-start">
              <FaceplateView
                mode="rendered"
                fit={pxPerMm}
                className="border-0 bg-transparent"
                {...shared}
              />
            </FitInBox>
          </div>
        )}
        {text &&
          (pictured ? (
            <>
              {/* The block's legibility scrim, so the text stays readable. */}
              <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/30 to-transparent" />
              <div className="relative flex h-full items-center gap-2 px-2">
                <span className="w-6 shrink-0 text-right font-mono text-[10px] text-zinc-300 tabular-nums">
                  {d.position}
                </span>
                <span className="truncate text-[12px] font-medium text-white">
                  {d.name}
                </span>
                <PortsBadge ports={state.ports} />
                {d.u_height > 1 && (
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-300 tabular-nums">
                    {d.u_height}U
                  </span>
                )}
              </div>
            </>
          ) : (
            // The name strip across the top, as a cabinet's faces carry it.
            <div className="relative flex h-4 items-center gap-2 px-2">
              <span className="w-6 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                {d.position}
              </span>
              <span className="truncate text-[10px] font-medium text-foreground">
                {d.name}
              </span>
              <PortsBadge ports={state.ports} />
            </div>
          ))}
      </div>
    </PortTraceProvider>
  )
}
