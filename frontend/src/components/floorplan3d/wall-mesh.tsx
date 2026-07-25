import { useMemo } from "react"

import {
  WALL_THICKNESS_M,
  cellToWorld,
  mm,
  wallSegmentsWithOpenings,
  type ScenePayload,
  type SceneWall,
} from "./world"

/** Neutral zinc, the rack-frame family — walls are structure, not signal. */
const WALL_COLOR = "#27272a"

/**
 * One wall polyline as solid boxes with door gaps and lintels — the 3D read
 * of what Structure mode drew. Render-only (owner's rule: build in 2D, view
 * in 3D): no pointer handlers, nothing raycastable, no animation, so the
 * demand frameloop never ticks for a wall. Spans extend half a thickness at
 * each end to close the corner joints of a multi-segment run.
 */
export function WallMesh({
  plan,
  wall,
}: {
  plan: ScenePayload["plan"]
  wall: SceneWall
}) {
  const heightM = mm(wall.height_mm ?? plan.ceiling_mm)
  const boxes = useMemo(
    () => wallSegmentsWithOpenings(wall.points, wall.openings ?? [], heightM),
    [wall.points, wall.openings, heightM]
  )
  const tint = wall.color || WALL_COLOR
  return (
    <group>
      {boxes.map((b, i) => {
        const [x0, z0] = cellToWorld(plan, b.x0, b.z0)
        const [x1, z1] = cellToWorld(plan, b.x1, b.z1)
        const len = Math.hypot(x1 - x0, z1 - z0)
        if (len < 1e-6) return null
        const rot = -Math.atan2(z1 - z0, x1 - x0)
        return (
          <mesh
            key={i}
            position={[(x0 + x1) / 2, (b.y0 + b.y1) / 2, (z0 + z1) / 2]}
            rotation={[0, rot, 0]}
            raycast={() => null}
          >
            <boxGeometry
              args={[len + WALL_THICKNESS_M, b.y1 - b.y0, WALL_THICKNESS_M]}
            />
            <meshStandardMaterial color={tint} roughness={0.92} />
          </mesh>
        )
      })}
    </group>
  )
}
