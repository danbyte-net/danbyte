import { useEffect, useMemo, useState } from "react"
import { useThree } from "@react-three/fiber"
import { useQueries, useQuery } from "@tanstack/react-query"
import * as THREE from "three"

import { api } from "@/lib/api"
import type {
  Cabinet,
  Device,
  DeviceType,
  ImagePortMarker,
  ImagePorts,
  PortLabelSource,
} from "@/lib/api"
import { effectivePortLabelSource } from "@/lib/port-label"
import type { PlateBox } from "@/lib/photo-calibration"
import { frontPhoto, useCabinetDevices } from "@/components/cabinet-devices"
import type { LegendReporter } from "@/components/speed-scale"

import {
  offsetOnBodyM,
  photoFace,
  placeDevices,
  plateBoxM,
  plateFrameM,
  railBoxM,
} from "./cabinet-geometry"
import type { CabinetBoxM, PlacedDevice } from "./cabinet-geometry"
import {
  DEVICE_EDGE,
  DEVICE_FALLBACK,
  DEVICE_SELECTED,
  PortQuads,
  sharedBox,
  sharedEdges,
  sharedFaceMaterial,
  useFacePortState,
  useFaceTexture,
} from "./device-mesh"
import { mm } from "./world"
import type { PointerMenuAt } from "@/components/pointer-menu"

/** Galvanised steel: the mounting plate, and the brighter zinc of the
 * rails. */
const PLATE_COLOR = "#a9aeb2"
const RAIL_COLOR = "#d4d7da"
/** A device under the pointer, as a racked device is drawn. */
const DEVICE_HOVER = "#71717a"

const NO_ASPECTS: ReadonlyMap<string, number> = new Map()
const NO_MARKERS: ImagePortMarker[] = []

/** What the interior reads off a device type beyond the device rows: its
 * depth, and the ports marked on its photos. */
interface TypeFacts {
  depth: number | null
  ports: ImagePorts | null
}

/** The front markers a device's photo carries: its own layout where it has
 * one - which replaces the type's wholesale, as the server reads it -
 * else its type's. */
export function frontMarkers(
  device: Pick<Device, "image_ports">,
  typePorts: ImagePorts | null | undefined
): ImagePortMarker[] {
  const layout =
    device.image_ports != null ? device.image_ports : (typePorts ?? null)
  return layout?.front ?? NO_MARKERS
}

/** The markers of `markers` that land on the device's face: the photo is
 * clipped to the body, as the 2D plate clips it, and a marker whose middle
 * falls outside it goes with the photo. */
export function markersOnBody(
  markers: ImagePortMarker[],
  photo: PlateBox,
  body: PlateBox
): ImagePortMarker[] {
  const on = markers.filter((m) => {
    const x = photo.x + m.x * photo.width
    const y = photo.y + m.y * photo.height
    return (
      x >= body.x &&
      x <= body.x + body.width &&
      y >= body.y &&
      y <= body.y + body.height
    )
  })
  return on.length === markers.length ? markers : on
}

/**
 * A DIN-rail cabinet's insides, in its own frame (see `cabinet-geometry`):
 * the galvanised mounting plate, each rail as a bar of its profile, and
 * each device on its rail as a box of its type's true size - its front
 * photo on its face at true scale where the photo is calibrated, stretched
 * over the face where it is not, the plain role colour where there is none.
 * The ports marked on a photo are drawn on it as the room draws a racked
 * device's (`PortQuads`), each at its marker, coloured by its state. Hover
 * and click report the device or the port; the scene shows its card.
 *
 * Mounted only while the door is open, so a room fetches a cabinet's
 * contents when its door first opens and never for a shut one. The cabinet
 * and its devices come from the cabinet page's own queries (same keys), so
 * on that page they are already there; a device type's depth and marked
 * ports - not on the device rows - from its type, one request per type; the
 * markers resolved to ports in one bulk request for every device with a
 * photo, the room's own; SNMP state for the faces that draw interfaces.
 */
export function CabinetInterior({
  cabinetId,
  box,
  selectedDeviceId = null,
  selectedPort = null,
  markReserved = false,
  portLabelSource = "",
  portLabelColor = "#ffffff",
  onSelectDevice,
  onHoverDevice,
  onSelectPort,
  onHoverPort,
  onPortMenu,
  onLegend,
}: {
  cabinetId: string
  box: CabinetBoxM
  selectedDeviceId?: string | null
  /** The port picked on a device's photo: the device and the marker. */
  selectedPort?: { deviceId: string; marker: string } | null
  /** Draw ports held for a cable amber. */
  markReserved?: boolean
  /** The deployment's port-label choice and colour. */
  portLabelSource?: PortLabelSource
  portLabelColor?: string
  onSelectDevice?: (deviceId: string) => void
  /** Pointer over (true) or off (false) a device. */
  onHoverDevice?: (deviceId: string, on: boolean) => void
  onSelectPort?: (deviceId: string, marker: ImagePortMarker) => void
  /** Pointer over (true) or off (false) a port. */
  onHoverPort?: (deviceId: string, marker: ImagePortMarker, on: boolean) => void
  /** A hardware marker right-clicked, at the pointer. */
  onPortMenu?: (
    deviceId: string,
    marker: ImagePortMarker,
    at: PointerMenuAt
  ) => void
  /** The colours the ports put on screen, by device. */
  onLegend?: LegendReporter
}) {
  const cabinet = useQuery({
    queryKey: ["cabinet", cabinetId],
    queryFn: () => api<Cabinet>(`/api/cabinets/${cabinetId}/`),
  })
  const devices = useCabinetDevices(cabinetId)
  const rows = devices.data?.results
  const typeIds = useMemo(
    () =>
      [
        ...new Set(
          (rows ?? []).flatMap((d) => (d.device_type ? [d.device_type.id] : []))
        ),
      ].sort(),
    [rows]
  )
  const facts = useQueries({
    queries: typeIds.map((id) => ({
      queryKey: ["device-type", id],
      queryFn: () => api<DeviceType>(`/api/device-types/${id}/`),
      staleTime: 5 * 60_000,
      // No depth is no reason to wait: the fallback depth stands in.
      retry: false,
    })),
    combine: typeFactsOf,
  })
  const factsOf = useMemo(() => {
    const byType = new Map(typeIds.map((id, i) => [id, facts[i] ?? null]))
    return (id: string | undefined) => (id ? byType.get(id) : null) ?? null
  }, [typeIds, facts])
  const depthOf = useMemo(
    () => (id: string) => factsOf(id)?.depth ?? null,
    [factsOf]
  )

  const c = cabinet.data
  const frame = useMemo(
    () =>
      c
        ? plateFrameM(box, {
            width_mm: c.inner_width_mm,
            height_mm: c.inner_height_mm,
          })
        : null,
    [c, box]
  )
  const placed = useMemo(
    () => (frame && c ? placeDevices(frame, c.rails, rows ?? [], depthOf) : []),
    [frame, c, rows, depthOf]
  )

  // A device or rail that goes away is a removal, which draws nothing on
  // its own (see the stage) - kick a frame whenever what is drawn changes.
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    invalidate()
  }, [frame, placed, invalidate])

  if (!frame || !c) return null
  const plate = plateBoxM(frame)
  return (
    <group>
      <mesh position={plate.center} castShadow receiveShadow>
        <boxGeometry args={plate.size} />
        <meshStandardMaterial
          color={PLATE_COLOR}
          roughness={0.5}
          metalness={0.45}
        />
      </mesh>
      {c.rails.map((r) => {
        const bar = railBoxM(frame, r)
        return (
          <mesh key={r.id} position={bar.center} castShadow receiveShadow>
            <boxGeometry args={bar.size} />
            <meshStandardMaterial
              color={RAIL_COLOR}
              roughness={0.35}
              metalness={0.6}
            />
          </mesh>
        )
      })}
      {placed.map((p) => (
        <InteriorDevice
          key={p.device.id}
          placed={p}
          markers={frontMarkers(
            p.device,
            factsOf(p.device.device_type?.id)?.ports
          )}
          selected={p.device.id === selectedDeviceId}
          selectedPort={
            selectedPort?.deviceId === p.device.id ? selectedPort.marker : null
          }
          markReserved={markReserved}
          portLabelSource={portLabelSource}
          portLabelColor={portLabelColor}
          onSelect={onSelectDevice}
          onHover={onHoverDevice}
          onSelectPort={onSelectPort}
          onHoverPort={onHoverPort}
          onPortMenu={onPortMenu}
          onLegend={onLegend}
        />
      ))}
    </group>
  )
}

/** One device on its rail: a box of its type's size in its role's colour,
 * its front photo on the face and the ports marked on the photo over it. */
function InteriorDevice({
  placed,
  markers,
  selected,
  selectedPort,
  markReserved,
  portLabelSource,
  portLabelColor,
  onSelect,
  onHover,
  onSelectPort,
  onHoverPort,
  onPortMenu,
  onLegend,
}: {
  placed: PlacedDevice
  /** The front markers of its photo (`frontMarkers`). */
  markers: ImagePortMarker[]
  selected: boolean
  selectedPort: string | null
  markReserved: boolean
  portLabelSource: PortLabelSource
  portLabelColor: string
  onSelect?: (deviceId: string) => void
  onHover?: (deviceId: string, on: boolean) => void
  onSelectPort?: (deviceId: string, marker: ImagePortMarker) => void
  onHoverPort?: (deviceId: string, marker: ImagePortMarker, on: boolean) => void
  onPortMenu?: (
    deviceId: string,
    marker: ImagePortMarker,
    at: PointerMenuAt
  ) => void
  onLegend?: LegendReporter
}) {
  const { device: d, rail, body, box } = placed
  const [hovered, setHovered] = useState(false)
  const href = d.device_type?.front_image ?? null
  const texture = useFaceTexture(href)
  // A calibrated photo's true height needs its aspect, which the loaded
  // texture knows - the 2D plate waits for the image the same way.
  const aspect = textureAspect(texture)
  const photo = useMemo(
    () =>
      href
        ? frontPhoto(
            d,
            rail,
            body,
            aspect ? new Map([[href, aspect]]) : NO_ASPECTS
          )
        : null,
    [d, rail, body, href, aspect]
  )
  const face = useMemo(
    () => (texture && photo?.box ? photoFace(body, photo.box) : null),
    [texture, photo, body]
  )
  const facePlane = useFacePlane(face)
  const [fx, fy] = face ? offsetOnBodyM(body, face.rect) : [0, 0]

  // The ports on the photo: drawn with it, at its scale, as far as it shows.
  const shown = useMemo(
    () =>
      face && photo?.box ? markersOnBody(markers, photo.box, body) : NO_MARKERS,
    [face, photo, markers, body]
  )
  // Every device with a photo resolves its markers in the bulk request the
  // interior's first render sends - before its type says which ports it
  // marks, so they all ride one request. SNMP only for a face that draws
  // interfaces: a request per device.
  const { resolved, observed } = useFacePortState({
    deviceId: d.id,
    markers: shown,
    side: "front",
    enabled: !!href,
    observe: shown.some((m) => (m.kind || "interface") === "interface"),
    onLegend,
  })
  const labelSource = effectivePortLabelSource(portLabelSource, d.port_labels)
  const [px, py] = photo?.box ? offsetOnBodyM(body, photo.box) : [0, 0]

  const id = d.id
  // A device unmounted under the pointer never gets its pointer-out.
  useEffect(() => () => onHover?.(id, false), [onHover, id])

  const [w, h, depth] = box.size
  const bodyColor = selected
    ? DEVICE_SELECTED
    : hovered
      ? DEVICE_HOVER
      : d.role?.color || DEVICE_FALLBACK
  return (
    <group
      position={box.center}
      onClick={(e) => {
        e.stopPropagation()
        onSelect?.(id)
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        onHover?.(id, true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        onHover?.(id, false)
        document.body.style.cursor = ""
      }}
    >
      <mesh geometry={sharedBox(w, h, depth)} castShadow receiveShadow>
        <meshStandardMaterial
          color={bodyColor}
          roughness={0.55}
          metalness={0.2}
        />
      </mesh>
      {texture && facePlane && (
        // On the face, a hair proud of it, turned to look out of the front
        // (−Z) - which also puts the photo's left on your left.
        <mesh
          geometry={facePlane}
          material={sharedFaceMaterial(texture)}
          position={[fx, fy, -depth / 2 - 0.0005]}
          rotation={[0, Math.PI, 0]}
        />
      )}
      {photo?.box && shown.length > 0 && (
        // The whole photo's frame - the markers are fractions of it - in
        // the plane of the photo, turned the same way.
        <group
          position={[px, py, -depth / 2 - 0.0005]}
          rotation={[0, Math.PI, 0]}
        >
          <PortQuads
            markers={shown}
            resolved={resolved}
            observed={observed}
            width={mm(photo.box.width)}
            height={mm(photo.box.height)}
            selectedPort={selectedPort}
            markReserved={markReserved}
            labelSource={labelSource}
            labelColor={portLabelColor}
            onSelect={(m) => onSelectPort?.(id, m)}
            onHover={
              onHoverPort ? (m, on) => onHoverPort(id, m, on) : undefined
            }
            onMenu={onPortMenu ? (m, at) => onPortMenu(id, m, at) : undefined}
          />
        </group>
      )}
      <lineSegments geometry={sharedEdges(w, h, depth)} raycast={() => null}>
        <lineBasicMaterial
          color={selected ? DEVICE_SELECTED : DEVICE_EDGE}
          transparent={!selected}
          opacity={selected ? 1 : 0.5}
        />
      </lineSegments>
    </group>
  )
}

/** Each device type's facts, in query order - null until it has loaded. */
function typeFactsOf(
  results: { data?: Pick<DeviceType, "depth_mm" | "image_ports"> }[]
): (TypeFacts | null)[] {
  return results.map((r) =>
    r.data
      ? { depth: r.data.depth_mm ?? null, ports: r.data.image_ports ?? null }
      : null
  )
}

/** A loaded texture's height over its width; null until it has loaded. */
function textureAspect(texture: THREE.Texture | null): number | null {
  const img = texture?.image as { width?: number; height?: number } | undefined
  return img?.width && img.height ? img.height / img.width : null
}

/** The plane a photo is drawn on: the part of the face it covers, mapped
 * to that part of the photo. */
function useFacePlane(
  face: { rect: PlateBox; uv: [number, number, number, number] } | null
): THREE.PlaneGeometry | null {
  const w = face?.rect.width ?? 0
  const h = face?.rect.height ?? 0
  const [u0, v0, u1, v1] = face?.uv ?? [0, 0, 1, 1]
  const geometry = useMemo(() => {
    if (w <= 0 || h <= 0) return null
    const g = new THREE.PlaneGeometry(mm(w), mm(h))
    // Corners top-left, top-right, bottom-left, bottom-right.
    g.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([u0, v1, u1, v1, u0, v0, u1, v0], 2)
    )
    return g
  }, [w, h, u0, v0, u1, v1])
  useEffect(() => () => geometry?.dispose(), [geometry])
  return geometry
}
