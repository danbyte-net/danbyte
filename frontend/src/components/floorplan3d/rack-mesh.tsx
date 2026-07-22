import { useState } from "react"
import { Detailed } from "@react-three/drei"
import * as THREE from "three"

import type { FloorTileCheck } from "@/lib/api"

import { DeviceMesh } from "./device-mesh"
import { TextSprite } from "./text-sprite"
import {
  cellToWorld,
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
  kind: "rack" | "device"
  tileId: string
  deviceId?: string
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
  onSelect,
  onFlyTo,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  check?: FloorTileCheck | null
  selection: Sel | null
  onSelect: (sel: Sel) => void
  onFlyTo: (target: THREE.Vector3, position: THREE.Vector3) => void
}) {
  const rack = tile.rack!
  const { width, depth, height } = rackFootprintM(rack)
  const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const rotY = (-tile.orientation * Math.PI) / 180
  const [hovered, setHovered] = useState(false)

  const rackSelected = selection?.tileId === tile.id && selection.kind === "rack"
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
    const position = target.clone().add(front).setY(height * 0.62)
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
      {/* LOD: index 0 shown when closer than 14 m, index 1 beyond. */}
      <Detailed distances={[0, 14]}>
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
                selection?.kind === "device" && selection.deviceId === d.id
              }
              showTexture
              onSelect={(deviceId) =>
                onSelect({ kind: "device", tileId: tile.id, deviceId })
              }
            />
          ))}
        </group>
        <Frame w={width} h={height} d={depth} color={frameColor} />
      </Detailed>
      {beacon && (
        <mesh position={[0, height + 0.03, 0]}>
          <boxGeometry args={[width * 0.6, 0.05, 0.06]} />
          <meshStandardMaterial
            color={beacon}
            emissive={beacon}
            emissiveIntensity={0.6}
          />
        </mesh>
      )}
      <TextSprite
        text={tile.label || rack.name}
        position={[0, height + 0.22, 0]}
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
