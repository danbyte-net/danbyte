import { useEffect, useMemo } from "react"
import * as THREE from "three"

import { areaColor, boxCorners } from "@/components/floorplan/shapes"
import type { AreaShape } from "@/components/floorplan/shapes"

import { cellM } from "./world"
import type { ScenePayload } from "./world"

/** Just over the room's grid lines, under the raised floors' slabs. */
const Y = 0.003

/**
 * A room or area drawn on the plan, as a flat tint on the 3D floor: its
 * rectangle (turned) or polygon in the area's colour. Render-only.
 */
export function AreaFloorMesh({
  plan,
  area,
}: {
  plan: ScenePayload["plan"]
  area: AreaShape
}) {
  const c = cellM(plan)
  const geometry = useMemo(() => {
    const pts = area.shape === "polygon" ? area.points : boxCorners(area)
    if (pts.length < 3) return null
    const shape = new THREE.Shape(
      pts.map(([x, y]) => new THREE.Vector2(x * c, y * c))
    )
    return new THREE.ShapeGeometry(shape)
  }, [area, c])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <mesh
      geometry={geometry}
      // The shape is drawn in x/y; lying down, its y runs along the floor's z.
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, Y, 0]}
      renderOrder={1}
    >
      <meshBasicMaterial
        color={areaColor(area)}
        transparent
        opacity={Math.max(0.12, area.fill_opacity / 100)}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  )
}
