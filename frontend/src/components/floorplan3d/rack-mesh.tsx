import { useMemo, useState } from "react"
import { Detailed } from "@react-three/drei"

import type { FloorTileCheck } from "@/lib/api"

import { TextSprite } from "./text-sprite"
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
const DEVICE_FALLBACK = "#52525b"

/**
 * One rack cabinet at its tile position. Two LOD tiers:
 *  - far: a single frame box + name plate (cheap — scales to large rooms)
 *  - near: frame + one box per racked device at true U position/size
 * The `check` beacon bar on top wears the rack's worst monitoring status,
 * fed from the same /state/ poll the 2D canvas uses.
 */
export function RackMesh({
  plan,
  tile,
  check,
  selected,
  onSelect,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  check?: FloorTileCheck | null
  selected: boolean
  onSelect: (tileId: string) => void
}) {
  const rack = tile.rack!
  const { width, depth, height } = rackFootprintM(rack)
  const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const rotY = (-tile.orientation * Math.PI) / 180
  const [hovered, setHovered] = useState(false)

  const frameColor = selected
    ? FRAME_SELECTED
    : hovered
      ? "#3f3f46"
      : FRAME_COLOR
  const beacon = check ? (CHECK_COLOR[check] ?? null) : null

  const devices = useMemo(
    () =>
      rack.devices.map((d) => {
        const { y, h } = deviceYM(rack, d)
        const dw = d.rack_width === "half" ? width * 0.44 : width * 0.92
        const dx =
          d.rack_side === "left"
            ? -width * 0.23
            : d.rack_side === "right"
              ? width * 0.23
              : 0
        const dd = d.is_full_depth ? depth * 0.9 : depth * 0.45
        const dz = d.face === "rear" ? depth * 0.45 - dd / 2 : dd / 2 - depth * 0.45
        return { d, y, h, dw, dx, dd, dz }
      }),
    [rack, width, depth]
  )

  return (
    <group
      position={[cx, 0, cz]}
      rotation={[0, rotY, 0]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(tile.id)
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
          {devices.map(({ d, y, h, dw, dx, dd, dz }) => (
            <mesh key={d.id} position={[dx, y + h / 2, dz]}>
              <boxGeometry args={[dw, h * 0.94, dd]} />
              <meshStandardMaterial
                color={d.role_color || DEVICE_FALLBACK}
                roughness={0.7}
              />
            </mesh>
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
