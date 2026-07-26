import { useState } from "react"

import type { ImagePortMarker } from "@/lib/api"

import {
  STRIP_D_M,
  STRIP_PORT_QUAD_M,
  STRIP_W_M,
  sideStripBoxM,
  stripPortLocalM,
} from "./world"
import type { SceneDevice, SceneRack } from "./world"

const STRIP_FALLBACK = "#3f3f46"
const STRIP_SELECTED = "#0ea5e9"
/** Same selection amber as the photo-port quads on device faces. */
const PORT_SELECTED = "#fbbf24"
/** Idle outlet quad — dim, the strip stays the star. */
const PORT_IDLE = "#a1a1aa"

/**
 * A side-mounted 0U strip (vertical PDU) hanging on its rack rail — the
 * render the shelf-appliance box could never be for a 42U power strip.
 * Clickable like any device (HUD + Open device); rendered in BOTH LOD tiers
 * (one box is cheap and a PDU that pops in and out reads as a glitch).
 *
 * `showPorts` (detail tier) adds one clickable quad per power outlet/port on
 * the strip's end face, laid out by world.stripPortLocalM — the SAME function
 * the cable layer anchors runs with, so a cord and its outlet can't disagree.
 * Clicking one selects it exactly like a photo port (HUD + connect flow).
 */
export function SideStripMesh({
  rack,
  dev,
  rackWidthM,
  rackDepthM,
  selected,
  selectedPort,
  showPorts = false,
  onSelect,
  onSelectPort,
}: {
  rack: SceneRack
  dev: SceneDevice
  rackWidthM: number
  rackDepthM: number
  selected: boolean
  /** Name of the port currently selected on THIS strip, if any. */
  selectedPort?: string | null
  /** Detail tier only — a far hall must not carry thousands of quads. */
  showPorts?: boolean
  onSelect: () => void
  /** An outlet/port quad was clicked — same contract as DeviceMesh's. */
  onSelectPort?: (marker: ImagePortMarker, side: "front" | "rear") => void
}) {
  const [hovered, setHovered] = useState(false)
  const [hoveredPort, setHoveredPort] = useState<string | null>(null)
  const box = sideStripBoxM(rack, dev, rackWidthM, rackDepthM)
  const { x, y, h, z } = box
  const color = selected
    ? STRIP_SELECTED
    : hovered
      ? "#71717a"
      : dev.role_color || STRIP_FALLBACK
  const ports: { name: string; kind: string }[] = showPorts
    ? [
        ...(dev.power_ports ?? []).map((name) => ({
          name,
          kind: "power-port",
        })),
        ...(dev.power_outlets ?? []).map((name) => ({
          name,
          kind: "power-outlet",
        })),
      ]
    : []
  return (
    <group>
      <mesh
        position={[x, y + h / 2, z]}
        castShadow
        onClick={(e) => {
          e.stopPropagation()
          onSelect()
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
        <boxGeometry args={[STRIP_W_M, h, STRIP_D_M]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
      </mesh>
      {ports.map((p) => {
        const at = stripPortLocalM(box, dev, p.name)
        const isSel = selectedPort != null && p.name === selectedPort
        const isHot = hoveredPort === p.name
        return (
          <mesh
            key={p.name}
            name={p.name}
            position={[at.x, at.y, at.z]}
            rotation={[0, at.out === 1 ? 0 : Math.PI, 0]}
            onClick={(e) => {
              e.stopPropagation()
              // Unmarked power components resolve under face-ports' REAR
              // list (power lives on the back) — pass the matching side.
              onSelectPort?.({ ...p, x: 0.5, y: 0.5, w: 1, h: 1 }, "rear")
            }}
            onPointerOver={(e) => {
              e.stopPropagation()
              setHoveredPort(p.name)
              document.body.style.cursor = "pointer"
            }}
            onPointerOut={(e) => {
              e.stopPropagation()
              setHoveredPort((cur) => (cur === p.name ? null : cur))
              document.body.style.cursor = ""
            }}
          >
            <planeGeometry args={[STRIP_PORT_QUAD_M, STRIP_PORT_QUAD_M]} />
            <meshBasicMaterial
              color={isSel ? PORT_SELECTED : PORT_IDLE}
              transparent
              opacity={isSel || isHot ? 0.9 : 0.45}
              toneMapped={false}
              depthWrite={false}
            />
          </mesh>
        )
      })}
    </group>
  )
}
