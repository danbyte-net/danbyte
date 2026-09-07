import { useMemo } from "react"

import {
  WALL_THICKNESS_M,
  cellToWorld,
  mm,
  wallSegmentsWithOpenings,
} from "./world"
import type { ScenePayload, SceneWall } from "./world"

/** Neutral zinc, the rack-frame family - walls are structure, not signal. */
const WALL_COLOR = "#27272a"
/** X-ray default: lighter than the floor slab. A 0.15-alpha ghost of the
 * floor's own hex composites to the floor's own color - literally invisible
 * on the dark theme - so the ghost gets a tint the ground doesn't have. */
const GHOST_COLOR = "#52525b"

/**
 * One wall polyline as solid boxes with door gaps and lintels - the 3D read
 * of what Structure mode drew. Render-only (owner's rule: build in 2D, view
 * in 3D): no pointer handlers, nothing raycastable, no animation, so the
 * demand frameloop never ticks for a wall. Spans extend half a thickness at
 * each end to close the corner joints of a multi-segment run.
 *
 * X-ray ghosts walls (the room's one transparency convention); every other
 * shell mode leaves them at full height - a knee-cap variant shipped once
 * and read as "my walls broke", so the Walls toggle is the way to clear
 * the view instead.
 */
export function WallMesh({
  plan,
  wall,
  mode = "solid",
}: {
  plan: ScenePayload["plan"]
  wall: SceneWall
  mode?: "solid" | "ghost"
}) {
  const heightM = mm(wall.height_mm ?? plan.ceiling_mm)
  const boxes = useMemo(
    () => wallSegmentsWithOpenings(wall.points, wall.openings, heightM),
    [wall.points, wall.openings, heightM]
  )
  const tint = wall.color || WALL_COLOR
  const ghost = mode === "ghost"
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
            castShadow={!ghost}
            receiveShadow={!ghost}
          >
            <boxGeometry
              args={[len + WALL_THICKNESS_M, b.y1 - b.y0, WALL_THICKNESS_M]}
            />
            {/* ONE material element, keyed by mode, every mode-dependent prop
                explicit. A solid/ghost ternary of the same element type is
                diffed IN PLACE, and r3f resets the removed props to 0 - not
                their defaults (three's material constructors take an arg, so
                the default-restore path never runs). transparent=0 then fails
                both of three's strict ===true/===false checks: opaque render
                list, alpha 0 - walls vanished until a recompile with luckier
                state. The key remounts a fresh material so the shader's
                OPAQUE define always matches the mode. */}
            <meshStandardMaterial
              key={ghost ? "ghost" : "solid"}
              color={ghost && !wall.color ? GHOST_COLOR : tint}
              roughness={0.92}
              transparent={ghost}
              opacity={ghost ? 0.3 : 1}
              depthWrite={!ghost}
            />
          </mesh>
        )
      })}
    </group>
  )
}
