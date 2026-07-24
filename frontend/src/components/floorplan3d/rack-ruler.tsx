import { useEffect, useMemo } from "react"
import * as THREE from "three"

import { PANEL_MM } from "@/lib/faceplate-geometry"

import { RACK_BASE_M, mm, type SceneRack } from "./world"

/**
 * The rack's U-number ruler: one canvas texture on a strip standing on the
 * cabinet's FRONT face, at the left rail, facing the aisle (−Z) — exactly
 * where a real rack prints its unit numbers, so it's readable head-on instead
 * of edge-on. One texture per rack (not 42 sprites), cached by the fields that
 * determine the numbering. Near racks only.
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
  const stripW = 0.06

  const texture = useMemo(() => {
    const rows = rack.u_height
    const rowPx = 26
    const canvas = document.createElement("canvas")
    canvas.width = 56
    canvas.height = rows * rowPx
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "rgba(9,9,11,0.92)"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#e4e4e7"
    ctx.font = "700 16px ui-monospace, monospace"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    for (let i = 0; i < rows; i++) {
      // Canvas y=0 is the TOP. Row i from the top shows:
      const num = rack.desc_units
        ? rack.starting_unit + i
        : rack.starting_unit + rows - 1 - i
      ctx.fillText(String(num), canvas.width / 2, i * rowPx + rowPx / 2)
      if (i > 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.08)"
        ctx.beginPath()
        ctx.moveTo(0, i * rowPx)
        ctx.lineTo(canvas.width, i * rowPx)
        ctx.stroke()
      }
    }
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [rack.u_height, rack.starting_unit, rack.desc_units])

  useEffect(() => () => texture.dispose(), [texture])

  return (
    // Front face = −Z; rotate π about Y so the texture reads from the aisle.
    // Just inside the left frame, a hair in front of the face to avoid z-fight.
    <mesh
      position={[-width / 2 + stripW / 2 + 0.01, RACK_BASE_M + rulerH / 2,
        -depth / 2 - 0.008]}
      rotation={[0, Math.PI, 0]}
      raycast={() => null}
    >
      <planeGeometry args={[stripW, rulerH]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  )
}
