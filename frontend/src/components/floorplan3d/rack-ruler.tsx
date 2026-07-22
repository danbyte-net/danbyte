import { useEffect, useMemo } from "react"
import * as THREE from "three"

import { PANEL_MM } from "@/lib/faceplate-geometry"

import { RACK_BASE_M, mm, type SceneRack } from "./world"

/**
 * The rack's U-number ruler as a single canvas texture on a thin plane at the
 * front-left rail — one texture per rack (not 42 sprites), cached by the three
 * fields that determine the numbering. Toggled on, near racks only.
 *
 * Numbering matches the 2D elevation: default (ascending) puts the highest U
 * at the top; `desc_units` puts `starting_unit` at the top.
 */
export function RackRuler({
  rack,
  width,
  depth,
}: {
  rack: SceneRack
  width: number
  depth: number
}) {
  const rulerH = mm(rack.u_height * PANEL_MM.uPitch)

  const texture = useMemo(() => {
    const rows = rack.u_height
    const rowPx = 22
    const canvas = document.createElement("canvas")
    canvas.width = 40
    canvas.height = rows * rowPx
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "rgba(24,24,27,0.9)"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#a1a1aa"
    ctx.font = "600 13px ui-monospace, monospace"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    for (let i = 0; i < rows; i++) {
      // Canvas y=0 is the TOP of the plane. Row i from the top shows:
      const num = rack.desc_units
        ? rack.starting_unit + i
        : rack.starting_unit + rows - 1 - i
      ctx.fillText(String(num), canvas.width / 2, i * rowPx + rowPx / 2)
    }
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [rack.u_height, rack.starting_unit, rack.desc_units])

  useEffect(() => () => texture.dispose(), [texture])

  return (
    <mesh
      position={[-width / 2 + 0.02, RACK_BASE_M + rulerH / 2, -depth * 0.42]}
      raycast={() => null}
    >
      <planeGeometry args={[0.055, rulerH]} />
      <meshBasicMaterial
        map={texture}
        transparent
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  )
}
