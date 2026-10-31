import { useEffect, useMemo } from "react"
import type { ThreeEvent } from "@react-three/fiber"
import * as THREE from "three"

import { areaColor, boxCorners } from "@/components/floorplan/shapes"
import type { AreaShape } from "@/components/floorplan/shapes"

import { cellM } from "./world"
import type { ScenePayload } from "./world"

/** Just over the room's grid lines, under the raised floors' slabs. */
const Y = 0.003

/** The ids of every area under a click, nearest first. */
const areaIdsUnder = (e: ThreeEvent<MouseEvent>) =>
  e.intersections
    .map((i) => i.object.userData.areaId as string | undefined)
    .filter((id): id is string => !!id)

/**
 * A room or area drawn on the plan, as a flat tint on the 3D floor: its
 * rectangle (turned) or polygon in the area's colour. A click selects it
 * and a double-click frames it - a building on a site-wide plan - with
 * every area under the pointer handed up, so the scene can pick the room
 * inside the building rather than the building around it.
 */
export function AreaFloorMesh({
  plan,
  area,
  selected = false,
  onPick,
}: {
  plan: ScenePayload["plan"]
  area: AreaShape
  selected?: boolean
  /** `ids`: the areas under the pointer; `frame`: it was a double-click. */
  onPick?: (ids: string[], frame: boolean) => void
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
      userData={{ areaId: area.id }}
      onClick={
        onPick &&
        ((e) => {
          e.stopPropagation()
          onPick(areaIdsUnder(e), false)
        })
      }
      onDoubleClick={
        onPick &&
        ((e) => {
          e.stopPropagation()
          onPick(areaIdsUnder(e), true)
        })
      }
    >
      <meshBasicMaterial
        color={areaColor(area)}
        transparent
        opacity={Math.min(
          0.85,
          Math.max(0.12, area.fill_opacity / 100) + (selected ? 0.25 : 0)
        )}
        side={THREE.DoubleSide}
        depthWrite={false}
        // Pulled towards the camera so it never flickers into the floor or
        // the background a few millimetres below on a large site.
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-4}
      />
    </mesh>
  )
}
