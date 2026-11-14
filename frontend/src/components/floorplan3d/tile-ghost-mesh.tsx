import type { ThreeEvent } from "@react-three/fiber"

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
 *
 * Clickable like a rack or a device: a click selects the tile (drawn
 * stronger) and the plan pins its popover, which names the linked power
 * panel, feed or cooling source and links to it - as a click does on the
 * 2D plan.
 */
const GHOST_H = 2.0

export function TileGhostMesh({
  plan,
  tile,
  showName = true,
  selected = false,
  ghosted = false,
  onSelect,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  /** Off when Readable draws the room's names (readable-names.tsx). */
  showName?: boolean
  selected?: boolean
  /** Focus on another object, or left out by the plan's filter. */
  ghosted?: boolean
  /** A click on it, with the pointer's place in the room (px). */
  onSelect?: (at: { x: number; y: number }) => void
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
      <mesh
        position={[0, GHOST_H / 2, 0]}
        // Without a handler it stays out of the pick, as before.
        {...(onSelect
          ? {
              onClick: (e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation()
                onSelect({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
              },
              onPointerOver: (e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation()
                document.body.style.cursor = "pointer"
              },
              onPointerOut: () => {
                document.body.style.cursor = ""
              },
            }
          : { raycast: () => null })}
      >
        <boxGeometry args={[w * 0.94, GHOST_H, d * 0.94]} />
        <meshStandardMaterial
          color={tint}
          transparent
          opacity={selected ? 0.42 : ghosted ? 0.06 : 0.16}
          emissive={tint}
          emissiveIntensity={selected ? 0.35 : 0}
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
