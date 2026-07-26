import { cellToWorld, mm } from "./world"
import type { ScenePayload, SceneRaisedFloor } from "./world"

// Render-only construction geometry (owner's rule: build in 2D, view in 3D):
// no pointer handlers, nothing raycastable, no animation. Heights are small,
// so both LOD tiers can afford the five boxes per area.

/** Top-slab elevations, just above the room's grid lines (0.002/0.004). */
const TOP_Y = 0.006
const TOP_THICKNESS = 0.012
const SKIRT_T = 0.04

/**
 * One raised-floor area: a finished-floor slab a hair above the room slab,
 * four skirts dropping to the structural slab at −plenum, and a dark plenum
 * bottom. With the "Lift raised floor" peek on, the top goes translucent so
 * the underfloor trays and cable runs read through the void they live in.
 */
export function RaisedFloorMesh({
  plan,
  area,
  peek,
}: {
  plan: ScenePayload["plan"]
  area: SceneRaisedFloor
  peek: boolean
}) {
  const [x0, z0] = cellToWorld(plan, area.x, area.y)
  const [x1, z1] = cellToWorld(plan, area.x + area.w, area.y + area.h)
  const w = x1 - x0
  const d = z1 - z0
  const cx = x0 + w / 2
  const cz = z0 + d / 2
  const depth = mm(area.plenum_mm)
  const tint = area.color || "#3f3f46"
  return (
    <group>
      {/* Finished floor. Opaque enough to read as a platform; translucent in
          peek so the plenum contents show. depthWrite stays ON when solid so
          underfloor geometry is genuinely hidden — that's the honest render
          of a closed floor. */}
      <mesh position={[cx, TOP_Y, cz]} raycast={() => null} receiveShadow>
        <boxGeometry args={[w, TOP_THICKNESS, d]} />
        <meshStandardMaterial
          color={tint}
          roughness={0.9}
          transparent
          opacity={peek ? 0.14 : 0.92}
          depthWrite={!peek}
        />
      </mesh>
      {/* Plenum bottom — the structural slab. */}
      <mesh position={[cx, -depth, cz]} raycast={() => null}>
        <boxGeometry args={[w, 0.01, d]} />
        <meshStandardMaterial color="#18181b" roughness={1} />
      </mesh>
      {/* Skirts. Slightly translucent even when closed, hinting at the void
          from the aisle without opening it. */}
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
          raycast={() => null}
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
