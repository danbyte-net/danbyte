import { useEffect, useMemo } from "react"
import * as THREE from "three"

import type { CameraView } from "@/components/floorplan/camera-view"

import { cellM } from "./world"
import type { ScenePayload } from "./world"

/** Over the area tints (0.003) and their outlines, under the racks. */
const Y = 0.006

/**
 * The cameras' views on the 3D floor, as the 2D plan draws them: each
 * camera's visible area - its cone (or ring) cut short by the walls - as a
 * flat translucent fan in its colour with a dashed edge. A view is
 * star-shaped round its apex, so a fan of triangles from it fills it
 * exactly. Never picked: clicks go through to the floor and the racks.
 */
export function CameraFanMeshes({
  plan,
  views,
}: {
  plan: ScenePayload["plan"]
  views: readonly CameraView[]
}) {
  const c = cellM(plan)
  const built = useMemo(
    () =>
      views
        .filter((v) => v.polygon.length >= 3)
        .map((v) => {
          const pts = v.polygon
          const pos: number[] = []
          const [ox, oy] = v.origin
          // A sector's outline starts at its apex: fan over the rest. A
          // ring fans from the apex all the way round.
          const rim = v.ring ? [...pts, pts[0]] : pts.slice(1)
          for (let i = 0; i + 1 < rim.length; i++) {
            pos.push(ox * c, 0, oy * c)
            pos.push(rim[i][0] * c, 0, rim[i][1] * c)
            pos.push(rim[i + 1][0] * c, 0, rim[i + 1][1] * c)
          }
          const fan = new THREE.BufferGeometry()
          fan.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
          const edge = new THREE.BufferGeometry().setFromPoints(
            pts.map(([x, y]) => new THREE.Vector3(x * c, 0, y * c))
          )
          return { id: v.id, color: v.color, ring: v.ring, fan, edge }
        }),
    [views, c]
  )
  useEffect(
    () => () => {
      for (const b of built) {
        b.fan.dispose()
        b.edge.dispose()
      }
    },
    [built]
  )
  return (
    <group position={[0, Y, 0]}>
      {built.map((b) => (
        <group key={b.id}>
          <mesh geometry={b.fan} renderOrder={3} raycast={() => null}>
            <meshBasicMaterial
              color={b.color}
              transparent
              opacity={b.ring ? 0.12 : 0.18}
              toneMapped={false}
              side={THREE.DoubleSide}
              depthWrite={false}
              polygonOffset
              polygonOffsetFactor={-3}
              polygonOffsetUnits={-6}
            />
          </mesh>
          <lineLoop
            geometry={b.edge}
            renderOrder={3}
            raycast={() => null}
            onUpdate={(l: THREE.LineLoop) => l.computeLineDistances()}
          >
            <lineDashedMaterial
              color={b.color}
              transparent
              opacity={0.7}
              dashSize={0.2}
              gapSize={0.15}
              toneMapped={false}
              depthWrite={false}
            />
          </lineLoop>
        </group>
      ))}
    </group>
  )
}
