import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { cellToWorld, mm } from "./world"
import type { ScenePayload, SceneRaisedFloor } from "./world"

// Mostly render-only construction geometry (owner's rule: build in 2D, view
// in 3D) — the one interaction is the VIEW action of lifting a floor: click
// an area's edge skirt to peek into its plenum. Heights are small, so both
// LOD tiers can afford the few boxes per area.

/** Top-slab elevations, just above the room's grid lines (0.002/0.004). */
const TOP_Y = 0.006
const TOP_THICKNESS = 0.012
const SKIRT_T = 0.04
/** Standard raised-floor tile pitch (m) — the grid every operator addresses. */
const TILE_M = 0.6
/** Finished-floor opacity at rest, and lifted for the plenum peek. */
const OPACITY_SOLID = 0.92
const OPACITY_PEEK = 0.14

/**
 * One raised-floor area: a finished-floor slab with its 600 mm tile grid, four
 * skirts dropping to the structural slab at −plenum, and a dark plenum bottom.
 * `peek` (global toggle, x-ray, or this area lifted by clicking its skirt)
 * fades the top over ~0.4 s so the underfloor trays and cable runs read
 * through the void they live in — the fade animates on the demand frameloop
 * by invalidating only while it is actually moving.
 */
export function RaisedFloorMesh({
  plan,
  area,
  peek,
  onToggleLift,
}: {
  plan: ScenePayload["plan"]
  area: SceneRaisedFloor
  peek: boolean
  /** Click on the area's edge skirt — the per-area lift. */
  onToggleLift?: (areaId: string) => void
}) {
  const [x0, z0] = cellToWorld(plan, area.x, area.y)
  const [x1, z1] = cellToWorld(plan, area.x + area.w, area.y + area.h)
  const w = x1 - x0
  const d = z1 - z0
  const cx = x0 + w / 2
  const cz = z0 + d / 2
  const depth = mm(area.plenum_mm)
  const tint = area.color || "#3f3f46"

  // 600 mm tile grid on the finished floor, aligned to the area's origin —
  // tiles are how operators actually address floor positions.
  const grid = useMemo(() => {
    const pts: number[] = []
    for (let gx = TILE_M; gx < w - 1e-6; gx += TILE_M)
      pts.push(x0 + gx, 0, z0, x0 + gx, 0, z1)
    for (let gz = TILE_M; gz < d - 1e-6; gz += TILE_M)
      pts.push(x0, 0, z0 + gz, x1, 0, z0 + gz)
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [x0, z0, x1, z1, w, d])
  useEffect(() => () => grid.dispose(), [grid])

  // The lift animates the top's opacity toward its target; frames are
  // demanded only while the value is still moving.
  const topMat = useRef<THREE.MeshStandardMaterial>(null)
  const invalidate = useThree((s) => s.invalidate)
  useFrame((_, dt) => {
    const m = topMat.current
    if (!m) return
    const target = peek ? OPACITY_PEEK : OPACITY_SOLID
    const diff = target - m.opacity
    if (Math.abs(diff) < 0.01) {
      if (m.opacity !== target) {
        m.opacity = target
        // Solid floors write depth so the plenum is genuinely hidden —
        // the honest render of a closed floor.
        m.depthWrite = !peek
      }
      return
    }
    m.opacity += diff * Math.min(1, dt * 8)
    m.depthWrite = false
    invalidate()
  })

  return (
    <group>
      {/* Finished floor. */}
      <mesh position={[cx, TOP_Y, cz]} raycast={() => null} receiveShadow>
        <boxGeometry args={[w, TOP_THICKNESS, d]} />
        <meshStandardMaterial
          ref={topMat}
          color={tint}
          roughness={0.9}
          transparent
          opacity={peek ? OPACITY_PEEK : OPACITY_SOLID}
          depthWrite={!peek}
        />
      </mesh>
      {/* Tile grid, a hair above the finished floor. */}
      <lineSegments
        geometry={grid}
        position={[0, TOP_Y + TOP_THICKNESS / 2 + 0.001, 0]}
        raycast={() => null}
      >
        <lineBasicMaterial color="#18181b" transparent opacity={0.4} />
      </lineSegments>
      {/* Plenum bottom — the structural slab. */}
      <mesh position={[cx, -depth, cz]} raycast={() => null}>
        <boxGeometry args={[w, 0.01, d]} />
        <meshStandardMaterial color="#18181b" roughness={1} />
      </mesh>
      {/* Skirts: the area's visible edge, and the lift's click target —
          clicking the TOP would steal every deselect click on the pad. */}
      {(
        [
          [cx, z0 + SKIRT_T / 2, w, SKIRT_T],
          [cx, z1 - SKIRT_T / 2, w, SKIRT_T],
          [x0 + SKIRT_T / 2, cz, SKIRT_T, d],
          [x1 - SKIRT_T / 2, cz, SKIRT_T, d],
        ] as const
      ).map(([px, pz, sw, sd], i) => (
        <mesh
          key={i}
          position={[px, -depth / 2 + TOP_Y / 2, pz]}
          onClick={
            onToggleLift
              ? (e) => {
                  e.stopPropagation()
                  onToggleLift(area.id)
                }
              : undefined
          }
          onPointerOver={
            onToggleLift
              ? (e) => {
                  e.stopPropagation()
                  document.body.style.cursor = "pointer"
                }
              : undefined
          }
          onPointerOut={
            onToggleLift
              ? () => {
                  document.body.style.cursor = ""
                }
              : undefined
          }
        >
          <boxGeometry args={[sw, depth + TOP_Y, sd]} />
          <meshStandardMaterial
            color={tint}
            roughness={0.9}
            transparent
            opacity={peek ? 0.25 : 0.5}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  )
}
