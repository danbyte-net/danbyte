import { useEffect, useMemo, useState } from "react"
import { useThree } from "@react-three/fiber"
import { useQueries, useQuery } from "@tanstack/react-query"
import * as THREE from "three"

import { api } from "@/lib/api"
import type { Cabinet, DeviceType } from "@/lib/api"
import type { PlateBox } from "@/lib/photo-calibration"
import { frontPhoto, useCabinetDevices } from "@/components/cabinet-devices"

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
  sharedBox,
  sharedEdges,
  sharedFaceMaterial,
  useFaceTexture,
} from "./device-mesh"
import { mm } from "./world"

/** Galvanised steel: the mounting plate, and the brighter zinc of the
 * rails. */
const PLATE_COLOR = "#a9aeb2"
const RAIL_COLOR = "#d4d7da"
/** A device under the pointer, as a racked device is drawn. */
const DEVICE_HOVER = "#71717a"

const NO_ASPECTS: ReadonlyMap<string, number> = new Map()

/**
 * A DIN-rail cabinet's insides, in its own frame (see `cabinet-geometry`):
 * the galvanised mounting plate, each rail as a bar of its profile, and
 * each device on its rail as a box of its type's true size - its front
 * photo on its face at true scale where the photo is calibrated, stretched
 * over the face where it is not, the plain role colour where there is none.
 * Hover and click report the device; the scene shows its card.
 *
 * Mounted only while the door is open, so a room fetches a cabinet's
 * contents when its door first opens and never for a shut one. The cabinet
 * and its devices come from the cabinet page's own queries (same keys), so
 * on that page they are already there; a device type's depth - not on the
 * device rows - from its type, one request per type.
 */
export function CabinetInterior({
  cabinetId,
  box,
  selectedDeviceId = null,
  onSelectDevice,
  onHoverDevice,
}: {
  cabinetId: string
  box: CabinetBoxM
  selectedDeviceId?: string | null
  onSelectDevice?: (deviceId: string) => void
  /** Pointer over (true) or off (false) a device. */
  onHoverDevice?: (deviceId: string, on: boolean) => void
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
  const depths = useQueries({
    queries: typeIds.map((id) => ({
      queryKey: ["device-type", id],
      queryFn: () => api<DeviceType>(`/api/device-types/${id}/`),
      staleTime: 5 * 60_000,
      // No depth is no reason to wait: the fallback depth stands in.
      retry: false,
    })),
    combine: depthsOf,
  })
  const depthOf = useMemo(() => {
    const byType = new Map(typeIds.map((id, i) => [id, depths[i] ?? null]))
    return (id: string) => byType.get(id) ?? null
  }, [typeIds, depths])

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
          selected={p.device.id === selectedDeviceId}
          onSelect={onSelectDevice}
          onHover={onHoverDevice}
        />
      ))}
    </group>
  )
}

/** One device on its rail: a box of its type's size in its role's colour,
 * its front photo on the face. */
function InteriorDevice({
  placed,
  selected,
  onSelect,
  onHover,
}: {
  placed: PlacedDevice
  selected: boolean
  onSelect?: (deviceId: string) => void
  onHover?: (deviceId: string, on: boolean) => void
}) {
  const { device: d, rail, body, box } = placed
  const [hovered, setHovered] = useState(false)
  const href = d.device_type?.front_image ?? null
  const texture = useFaceTexture(href)
  // A calibrated photo's true height needs its aspect, which the loaded
  // texture knows - the 2D plate waits for the image the same way.
  const aspect = textureAspect(texture)
  const photo = href
    ? frontPhoto(d, rail, body, aspect ? new Map([[href, aspect]]) : NO_ASPECTS)
    : null
  const face = texture && photo?.box ? photoFace(body, photo.box) : null
  const facePlane = useFacePlane(face)
  const [fx, fy] = face ? offsetOnBodyM(body, face.rect) : [0, 0]

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

/** Each device type's depth, mm, in query order - one stable array while
 * the answers stay the same. */
function depthsOf(
  results: { data?: Pick<DeviceType, "depth_mm"> }[]
): (number | null)[] {
  return results.map((r) => r.data?.depth_mm ?? null)
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
