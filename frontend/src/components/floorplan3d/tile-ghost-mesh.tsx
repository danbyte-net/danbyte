import { cellToWorld } from "./world"
import type { ScenePayload, SceneTile } from "./world"

import { FaceLabel } from "./text-sprite"

/**
 * Planning massing for tiles that aren't racks: a translucent box with the
 * tile's colour and name. This is what "build in advance" looks like in 3D -
 * a typed tile needs NO linked object to hold its ground in the room, so a
 * future rack row reads as a row of ghosts instead of empty floor. Linked
 * racks render their real cabinets instead; zones stay flat floor patches.
 *
 * Height is a deliberate constant: tile types are the tenant's own visual
 * vocabulary, so nothing can honestly know how tall "Cooling unit" is.
 * 2 m says "something stands here" without pretending to be a model.
 */
const GHOST_H = 2.0

export function TileGhostMesh({
  plan,
  tile,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
}) {
  const [x0, z0] = cellToWorld(plan, tile.x, tile.y)
  const [x1, z1] = cellToWorld(plan, tile.x + tile.w, tile.y + tile.h)
  const w = x1 - x0
  const d = z1 - z0
  const tint = tile.color || "#71717a"
  const name = tile.label || tile.type_name || ""
  return (
    <group position={[x0 + w / 2, 0, z0 + d / 2]}>
      <mesh position={[0, GHOST_H / 2, 0]} raycast={() => null}>
        <boxGeometry args={[w * 0.94, GHOST_H, d * 0.94]} />
        <meshStandardMaterial
          color={tint}
          transparent
          opacity={0.16}
          roughness={0.95}
          depthWrite={false}
        />
      </mesh>
      {/* A slim base plate keeps the footprint readable from above even
          where ghosts overlap visually with grid lines. */}
      <mesh position={[0, 0.012, 0]} raycast={() => null}>
        <boxGeometry args={[w * 0.94, 0.024, d * 0.94]} />
        <meshStandardMaterial color={tint} transparent opacity={0.45} />
      </mesh>
      {name && (
        <FaceLabel
          text={name}
          heightM={0.09}
          align="center"
          position={[0, GHOST_H + 0.08, 0]}
        />
      )}
    </group>
  )
}
