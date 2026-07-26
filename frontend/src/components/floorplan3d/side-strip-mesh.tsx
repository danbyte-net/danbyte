import { useState } from "react"

import { STRIP_D_M, STRIP_W_M, sideStripBoxM } from "./world"
import type { SceneDevice, SceneRack } from "./world"

const STRIP_FALLBACK = "#3f3f46"
const STRIP_SELECTED = "#0ea5e9"

/**
 * A side-mounted 0U strip (vertical PDU) hanging on its rack rail — the
 * render the shelf-appliance box could never be for a 42U power strip.
 * Clickable like any device (HUD + Open device); rendered in BOTH LOD tiers
 * (one box is cheap and a PDU that pops in and out reads as a glitch).
 * Outlet-level markers arrive with the bulk-placement phase.
 */
export function SideStripMesh({
  rack,
  dev,
  rackWidthM,
  rackDepthM,
  selected,
  onSelect,
}: {
  rack: SceneRack
  dev: SceneDevice
  rackWidthM: number
  rackDepthM: number
  selected: boolean
  onSelect: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const { x, y, h, z } = sideStripBoxM(rack, dev, rackWidthM, rackDepthM)
  const color = selected
    ? STRIP_SELECTED
    : hovered
      ? "#71717a"
      : dev.role_color || STRIP_FALLBACK
  return (
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
  )
}
