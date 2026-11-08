import { tileWorldPose } from "./world"
import type { ScenePayload, SceneTile } from "./world"

import { TextSprite } from "./text-sprite"

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
  showName = true,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  /** Off when Readable draws the room's names (readable-names.tsx). */
  showName?: boolean
}) {
  // Its stored footprint, turned about its centre by its residual - the
  // same place and turn the 2D canvas draws it at (tile-pose.ts).
  const pose = tileWorldPose(plan, tile)
  const { w, d } = pose.footprint
  const tint = tile.color || "#71717a"
  // Same fallback as the 2D canvas: manual label, else the linked device's
  // name, else the tile type ("build in advance" massing).
  const name = tile.label || tile.device_name || tile.type_name || ""
  return (
    <group
      position={[pose.centre[0], 0, pose.centre[1]]}
      rotation={[0, pose.residualRotY, 0]}
    >
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
      {/* Billboarded so the name reads from ANY camera angle - a flat plate
          on a 2 m box is legible from one side of the room only. Floats just
          above the massing, like the rack HUD labels. */}
      {name && showName && (
        <TextSprite
          text={name}
          heightM={0.16}
          position={[0, GHOST_H + 0.2, 0]}
        />
      )}
    </group>
  )
}
