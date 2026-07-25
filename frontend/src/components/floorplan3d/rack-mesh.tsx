import { useMemo, useRef, useState } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import type { FloorTileCheck } from "@/lib/api"

import type { LegendReporter } from "@/components/speed-scale"

import { AirflowGlyphs } from "./airflow-glyphs"
import { DeviceMesh } from "./device-mesh"
import { RackRuler } from "./rack-ruler"
import { FaceLabel } from "./text-sprite"
import {
  cellToWorld,
  deviceYM,
  rackFootprintM,
  type ScenePayload,
  type SceneTile,
} from "./world"

/** Monitoring worst-status → beacon color (same semantics as the 2D rings). */
const CHECK_COLOR: Record<string, string> = {
  down: "#ef4444",
  degraded: "#f59e0b",
  stale: "#f59e0b",
  up: "#10b981",
}

const FRAME_COLOR = "#18181b"
const FRAME_SELECTED = "#0ea5e9"

export interface Sel {
  kind: "rack" | "device" | "port"
  tileId: string
  deviceId?: string
  /** Set when kind === "port": the clicked photo-port marker. */
  portName?: string
  portKind?: string
  portSide?: "front" | "rear"
}

/**
 * One rack cabinet at its tile position. Two LOD tiers:
 *  - far: a single frame box + name plate (cheap — scales to large rooms)
 *  - near: open shell + one clickable box per racked device at true U
 *    position/size, wearing its device-type face image
 * The `check` beacon bar on top wears the rack's worst monitoring status,
 * fed from the same /state/ poll the 2D canvas uses. Double-click flies the
 * camera to frame the cabinet's front.
 */
export function RackMesh({
  plan,
  tile,
  check,
  selection,
  showUNumbers,
  showNames,
  showAirflow,
  onSelect,
  onFlyTo,
  onLegend,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  check?: FloorTileCheck | null
  selection: Sel | null
  showUNumbers: boolean
  showNames: boolean
  /** Draw intake/exhaust cones per device (near tier only). */
  showAirflow?: boolean
  onSelect: (sel: Sel) => void
  onFlyTo: (target: THREE.Vector3, position: THREE.Vector3) => void
  /** Forwarded to each device so the room's legend keys what's on screen. */
  onLegend?: LegendReporter
}) {
  const rack = tile.rack!
  const { width, depth, height } = rackFootprintM(rack)
  const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const rotY = (-tile.orientation * Math.PI) / 180
  const [hovered, setHovered] = useState(false)

  // Manual LOD (NOT drei <Detailed>/THREE.LOD): the raycaster ignores
  // `visible`, so an invisible far-tier solid box would sit in front of the
  // devices and eat their clicks. Mount exactly one tier instead — unmounted
  // meshes can't be raycast.
  //
  // Distance is measured to the cabinet's SURFACE (centre minus half its
  // diagonal), not its centre — centre-distance made big/edge-of-room racks
  // flip tiers later than they looked, reading as "devices missing up close".
  // Wide hysteresis (18 in / 24 out) kills popping while orbiting at the
  // threshold; with the demand frameloop this runs only on frames the
  // controls already trigger.
  const [near, setNear] = useState(false)
  const nearRef = useRef(false)
  const centre = useMemo(
    () => new THREE.Vector3(cx, height / 2, cz),
    [cx, cz, height]
  )
  const halfDiag = useMemo(
    () => Math.hypot(width, height, depth) / 2,
    [width, height, depth]
  )
  useFrame(({ camera }) => {
    const dist = camera.position.distanceTo(centre) - halfDiag
    const next = dist < (nearRef.current ? 24 : 18)
    if (next !== nearRef.current) {
      nearRef.current = next
      setNear(next)
    }
  })

  const rackSelected =
    selection?.tileId === tile.id && selection.kind === "rack"
  const frameColor = rackSelected
    ? FRAME_SELECTED
    : hovered
      ? "#3f3f46"
      : FRAME_COLOR
  const beacon = check ? (CHECK_COLOR[check] ?? null) : null

  const flyTo = () => {
    // Frame the front face: out along the rack's local −Z (front), eye at a
    // comfortable ~60% of cabinet height.
    const front = new THREE.Vector3(0, 0, -1)
      .applyEuler(new THREE.Euler(0, rotY, 0))
      .multiplyScalar(Math.max(height * 1.3, 2.2))
    const target = new THREE.Vector3(cx, height * 0.55, cz)
    const position = target
      .clone()
      .add(front)
      .setY(height * 0.62)
    onFlyTo(target, position)
  }

  return (
    <group
      position={[cx, 0, cz]}
      rotation={[0, rotY, 0]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: "rack", tileId: tile.id })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        flyTo()
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = ""
      }}
    >
      {/* LOD: open shell + clickable devices when the camera is close,
          one solid box beyond — only ever ONE tier mounted (see above). */}
      {near ? (
        <group>
          <Frame w={width} h={height} d={depth} color={frameColor} shell />
          {rack.devices.map((d) => (
            <DeviceMesh
              key={d.id}
              rack={rack}
              dev={d}
              rackWidthM={width}
              rackDepthM={depth}
              selected={
                (selection?.kind === "device" || selection?.kind === "port") &&
                selection.deviceId === d.id
              }
              selectedPort={
                selection?.kind === "port" && selection.deviceId === d.id
                  ? selection.portName
                  : null
              }
              showTexture
              onLegend={onLegend}
              onSelect={(deviceId) =>
                onSelect({ kind: "device", tileId: tile.id, deviceId })
              }
              onSelectPort={(deviceId, marker, side) =>
                onSelect({
                  kind: "port",
                  tileId: tile.id,
                  deviceId,
                  portName: marker.name,
                  portKind: marker.kind,
                  portSide: side,
                })
              }
            />
          ))}
        </group>
      ) : (
        <Frame w={width} h={height} d={depth} color={frameColor} />
      )}
      {/* Airflow cues — near tier only, like every overlay; the glyph layer
          reports its legend content and retracts it on unmount. */}
      {near && showAirflow && (
        <AirflowGlyphs rack={rack} legendKey={tile.id} onLegend={onLegend} />
      )}
      {/* Overlays — near tier only, and drawn FLAT on the front face so they
          stay anchored (billboards piled up in the aisle). */}
      {near && showUNumbers && (
        <RackRuler rack={rack} width={width} depth={depth} />
      )}
      {near &&
        showNames &&
        rack.devices.map((dev) => {
          const { y, h } = deviceYM(rack, dev)
          return (
            <FaceLabel
              key={`name-${dev.id}`}
              text={dev.name}
              // On the face, just right of the U-ruler rail, at the device's
              // slot; a hair in front of the photo. Height ≈ ⅔U so it fits.
              heightM={Math.min(0.03, h * 0.7)}
              align="left"
              position={[
                -width / 2 + (showUNumbers ? 0.09 : 0.03),
                y + h / 2,
                -depth / 2 - 0.01,
              ]}
            />
          )
        })}
      {beacon && (
        // raycast disabled — decoration must never steal the rack's clicks.
        <mesh position={[0, height + 0.03, 0]} raycast={() => null}>
          <boxGeometry args={[width * 0.6, 0.05, 0.06]} />
          <meshStandardMaterial
            color={beacon}
            emissive={beacon}
            emissiveIntensity={0.6}
          />
        </mesh>
      )}
      {/* Rack name plate — flat on the front, above the top U, facing the
          aisle. Flat (not billboard) so neighbours don't overlap. */}
      <FaceLabel
        text={tile.label || rack.name}
        heightM={0.11}
        align="center"
        position={[0, height + 0.09, -depth / 2 - 0.01]}
      />
    </group>
  )
}

/** The cabinet body. `shell` mode hollows the front/rear (open faces) by
 * drawing side panels + top/bottom instead of one solid box. */
function Frame({
  w,
  h,
  d,
  color,
  shell = false,
}: {
  w: number
  h: number
  d: number
  color: string
  shell?: boolean
}) {
  if (!shell) {
    return (
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
    )
  }
  const t = 0.03 // panel thickness
  return (
    <group>
      {/* left / right side panels */}
      <mesh position={[-w / 2 + t / 2, h / 2, 0]}>
        <boxGeometry args={[t, h, d]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      <mesh position={[w / 2 - t / 2, h / 2, 0]}>
        <boxGeometry args={[t, h, d]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      {/* top + base */}
      <mesh position={[0, h - t / 2, 0]}>
        <boxGeometry args={[w, t, d]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[w, 0.1, d]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
    </group>
  )
}
