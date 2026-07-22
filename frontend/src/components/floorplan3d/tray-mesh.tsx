import { useMemo } from "react"

import {
  TRAY_H_M,
  TRAY_W_M,
  cellToWorld,
  trayElevationM,
  type ScenePayload,
  type SceneTray,
} from "./world"

const TRAY_FALLBACK = "#f59e0b"

/** One tray polyline as per-segment boxes at its elevation — reads like
 * ladder tray without extrusion math. Underfloor runs sit below the slab and
 * show through it at glancing angles, which is exactly the hint we want. */
export function TrayMesh({
  plan,
  tray,
}: {
  plan: ScenePayload["plan"]
  tray: SceneTray
}) {
  const y = trayElevationM(plan, tray)
  const color = tray.color || TRAY_FALLBACK

  const segments = useMemo(() => {
    const out: {
      key: string
      cx: number
      cz: number
      len: number
      rot: number
    }[] = []
    for (let i = 0; i < tray.points.length - 1; i++) {
      const [ax, az] = cellToWorld(plan, tray.points[i][0], tray.points[i][1])
      const [bx, bz] = cellToWorld(
        plan,
        tray.points[i + 1][0],
        tray.points[i + 1][1]
      )
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) continue
      out.push({
        key: `${tray.id}:${i}`,
        cx: (ax + bx) / 2,
        cz: (az + bz) / 2,
        len,
        rot: -Math.atan2(dz, dx),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray.points, plan.cell_mm])

  return (
    <group>
      {segments.map((s) => (
        <mesh key={s.key} position={[s.cx, y, s.cz]} rotation={[0, s.rot, 0]}>
          {/* Slight overlong so corner joints close visually. */}
          <boxGeometry args={[s.len + TRAY_W_M * 0.5, TRAY_H_M, TRAY_W_M]} />
          <meshStandardMaterial
            color={color}
            roughness={0.6}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}
    </group>
  )
}
