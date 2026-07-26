import { useMemo, useState } from "react"

import {
  TRAY_H_M,
  TRAY_RAIL_T_M,
  TRAY_RUNG_PITCH_M,
  TRAY_RUNG_T_M,
  TRAY_W_M,
  cellToWorld,
  trayElevationM,
  type SceneRaisedFloor,
  type ScenePayload,
  type SceneTray,
} from "./world"

const TRAY_FALLBACK = "#f59e0b"
const TRAY_SELECTED = "#0ea5e9"

/**
 * One tray as a real basket: a floor of rungs between two side rails, open on
 * top, so the runs riding through it are VISIBLE — which is the whole point of
 * drawing trays at all. (v1 was a solid box per segment: it looked like a
 * painted girder and swallowed every cable inside it.)
 *
 * Clicking selects the tray; a SELECTED tray is "opened" — the near rail drops
 * away and the basket tints, so you can look straight into the run.
 */
export function TrayMesh({
  plan,
  tray,
  areas,
  selected = false,
  onSelect,
}: {
  plan: ScenePayload["plan"]
  tray: SceneTray
  /** Raised-floor areas — underfloor runs derive their depth from the void
   * they sit in rather than a constant. */
  areas?: SceneRaisedFloor[]
  /** Opened: near rail hidden, basket tinted, so the cables inside read. */
  selected?: boolean
  onSelect?: (trayId: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const y = trayElevationM(plan, tray, areas)
  const color = selected
    ? TRAY_SELECTED
    : hovered
      ? "#fbbf24"
      : tray.color || TRAY_FALLBACK

  const segments = useMemo(() => {
    const out: {
      key: string
      cx: number
      cz: number
      len: number
      rot: number
      rungs: number
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
        // Capped: a 60 m run must not mint 200 rung meshes.
        rungs: Math.min(48, Math.max(2, Math.round(len / TRAY_RUNG_PITCH_M))),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray.points, plan.cell_mm])

  // Basket floor sits half a section below the tray datum; rails stand on it.
  const floorY = -TRAY_H_M / 2 + TRAY_RAIL_T_M / 2
  const railY = -TRAY_H_M / 2 + TRAY_H_M / 2
  const railX = TRAY_W_M / 2 - TRAY_RAIL_T_M / 2

  return (
    <group
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation()
              onSelect(tray.id)
            }
          : undefined
      }
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = ""
      }}
    >
      {segments.map((s) => (
        <group key={s.key} position={[s.cx, y, s.cz]} rotation={[0, s.rot, 0]}>
          {/* Side rails. The near rail (−X in segment space, i.e. the one
              between you and the run when the tray is opened) is dropped
              while selected so the basket reads as cut open. */}
          {!selected && (
            <mesh position={[0, railY, -railX]} castShadow>
              <boxGeometry args={[s.len, TRAY_H_M, TRAY_RAIL_T_M]} />
              <meshStandardMaterial
                color={color}
                roughness={0.5}
                metalness={0.55}
              />
            </mesh>
          )}
          <mesh position={[0, railY, railX]} castShadow>
            <boxGeometry args={[s.len, TRAY_H_M, TRAY_RAIL_T_M]} />
            <meshStandardMaterial
              color={color}
              roughness={0.5}
              metalness={0.55}
            />
          </mesh>
          {/* Rungs across the floor — the ladder read, and what the cables
              visibly rest on. */}
          {Array.from({ length: s.rungs }, (_, i) => (
            <mesh
              key={i}
              position={[
                (((i + 0.5) / s.rungs) * 2 - 1) * (s.len / 2),
                floorY,
                0,
              ]}
              castShadow
            >
              <boxGeometry args={[TRAY_RUNG_T_M, TRAY_RUNG_T_M, TRAY_W_M]} />
              <meshStandardMaterial
                color={color}
                roughness={0.5}
                metalness={0.55}
              />
            </mesh>
          ))}
          {/* A thin invisible slab spanning the basket keeps the whole run
              easy to click — picking individual 10 mm rungs is hopeless. */}
          <mesh position={[0, railY, 0]}>
            <boxGeometry args={[s.len, TRAY_H_M, TRAY_W_M]} />
            <meshBasicMaterial colorWrite={false} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
}
