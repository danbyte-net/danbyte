import { useEffect, useMemo } from "react"
import { Line } from "@react-three/drei"
import * as THREE from "three"

import type { FloorPlanCablePath } from "@/lib/api"
import { useTheme } from "@/components/theme-provider"

import { slabOutline } from "./building-math"
import type { LevelPlacement } from "./building-math"
import { useCablePaths } from "./cable-trace-3d"
import { roomLook } from "./room-look"
import { useScene } from "./use-scene"
import { WallMesh } from "./wall-mesh"
import {
  cabinetBoxM,
  cellM,
  cellToWorld,
  floorDeviceBoxM,
  mm,
  rackFootprintM,
} from "./world"
import type { ScenePayload, SceneTile } from "./world"

/**
 * The other levels of an aligned floor plan around the active one: each
 * placed at its elevation and align offset (building-math.placeLevels).
 * A level below draws simplified - slab, walls and its racks, cabinets and
 * devices as plain boxes - and an upper one in "All" as a ghost: outlines
 * only, contents hidden. Each level loads its own scene, lazily and cached
 * (the same query its own 3D view uses). A click on another level makes it
 * the active one (`onGo`, with the tile clicked to fly to).
 */
export function BuildingLevels({
  levels,
  onGo,
}: {
  levels: LevelPlacement[]
  onGo: (floorId: string, tileId?: string) => void
}) {
  return (
    <>
      {levels.map((lv) =>
        lv.look === "solid" || lv.look === "ghost" ? (
          <group
            key={lv.floor.id}
            position={[lv.x, lv.y, lv.z]}
            rotation={[0, lv.rotY, 0]}
          >
            <OtherLevel placement={lv} onGo={onGo} />
          </group>
        ) : null
      )}
    </>
  )
}

function OtherLevel({
  placement,
  onGo,
}: {
  placement: LevelPlacement
  onGo: (floorId: string, tileId?: string) => void
}) {
  const scene = useScene(placement.floor.id)
  if (!scene.data) return null
  return placement.look === "ghost" ? (
    <GhostLevel scene={scene.data} onClick={() => onGo(placement.floor.id)} />
  ) : (
    <SimpleLevel
      scene={scene.data}
      onClick={(tileId) => onGo(placement.floor.id, tileId)}
    />
  )
}

/** A level's slab: its outline (exterior walls, else the grid box) as a
 * slab under its floor. */
export function Slab({
  scene,
  opacity = 1,
  sink = false,
  onClick,
}: {
  scene: ScenePayload
  opacity?: number
  /** Just under the floor: the active level's room draws its own. */
  sink?: boolean
  onClick?: () => void
}) {
  const look = roomLook(useTheme().theme === "dark")
  const { plan } = scene
  const thick = mm(plan.slab_mm ?? 300)
  const geom = useMemo(() => {
    const c = cellM(plan)
    const pts = slabOutline(scene.walls, plan)
    const shape = new THREE.Shape(
      pts.map(([x, y]) => new THREE.Vector2(x * c, y * c))
    )
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: thick,
      bevelEnabled: false,
    })
    // Shape (x, y) to the floor (x, z); the extrusion runs down from y = 0.
    g.rotateX(Math.PI / 2)
    if (sink) g.translate(0, -0.005, 0)
    return g
  }, [plan, scene.walls, thick, sink])
  useEffect(() => () => geom.dispose(), [geom])
  return (
    <mesh
      geometry={geom}
      receiveShadow
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation()
              onClick()
            }
          : undefined
      }
    >
      <meshStandardMaterial
        color={look.slab}
        roughness={0.95}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
      />
    </mesh>
  )
}

/** A box for a tile of another level: a rack, a cabinet or a placed
 * device at its height; nothing for other tiles. */
function tileBox(
  plan: ScenePayload["plan"],
  t: SceneTile
): { at: [number, number, number]; size: [number, number, number] } | null {
  const h = t.rack
    ? rackFootprintM(t.rack).height
    : t.cabinet
      ? cabinetBoxM(t.cabinet).height
      : t.device
        ? (floorDeviceBoxM(t.device)?.h ?? 0.5)
        : null
  if (h == null || t.is_zone) return null
  const c = cellM(plan)
  const [x, z] = cellToWorld(plan, t.x + t.w / 2, t.y + t.h / 2)
  return { at: [x, h / 2, z], size: [t.w * c * 0.92, h, t.h * c * 0.92] }
}

/** A level below the active one: slab, walls, and boxes for what stands
 * on it - no ports, faceplates or doors. */
function SimpleLevel({
  scene,
  onClick,
}: {
  scene: ScenePayload
  onClick: (tileId?: string) => void
}) {
  const { plan } = scene
  const boxes = useMemo(
    () =>
      scene.tiles
        .map((t) => ({ t, box: tileBox(plan, t) }))
        .filter((b) => b.box && !b.t.hidden),
    [scene.tiles, plan]
  )
  return (
    <group>
      <Slab scene={scene} onClick={() => onClick()} />
      {(scene.walls ?? []).map((w) => (
        <WallMesh key={w.id} plan={plan} wall={w} />
      ))}
      {boxes.map(({ t, box }) => (
        <mesh
          key={t.id}
          position={box!.at}
          castShadow
          onClick={(e) => {
            e.stopPropagation()
            onClick(t.id)
          }}
        >
          <boxGeometry args={box!.size} />
          <meshStandardMaterial color={t.color || "#71717a"} roughness={0.8} />
        </mesh>
      ))}
    </group>
  )
}

/** An upper level in "All": its slab and walls as outlines, a faint slab
 * to click. Nothing that stands on it. */
function GhostLevel({
  scene,
  onClick,
}: {
  scene: ScenePayload
  onClick: () => void
}) {
  const look = roomLook(useTheme().theme === "dark")
  const { plan } = scene
  const lines = useMemo(() => {
    const c = cellM(plan)
    const top = mm(plan.ceiling_mm)
    const out: [number, number, number][][] = []
    const ring = slabOutline(scene.walls, plan)
    const loop = [...ring, ring[0]]
    out.push(loop.map(([x, y]) => [x * c, 0, y * c]))
    for (const w of scene.walls ?? []) {
      const h = w.height_mm != null ? mm(w.height_mm) : top
      out.push(w.points.map(([x, y]) => [x * c, h, y * c]))
      out.push(w.points.map(([x, y]) => [x * c, 0.01, y * c]))
    }
    return out
  }, [plan, scene.walls])
  return (
    <group>
      <Slab scene={scene} opacity={0.08} onClick={onClick} />
      {lines.map((pts, i) =>
        pts.length >= 2 ? (
          <Line
            key={i}
            points={pts}
            color={look.wallEdge}
            lineWidth={1}
            transparent
            opacity={0.55}
          />
        ) : null
      )}
    </group>
  )
}

/** "Up to": a faint roofline over the cut - the top level's outline at
 * its ceiling. */
export function Roofline({ placement }: { placement: LevelPlacement }) {
  const scene = useScene(placement.floor.id)
  const look = roomLook(useTheme().theme === "dark")
  const pts = useMemo(() => {
    if (!scene.data) return null
    const { plan } = scene.data
    const c = cellM(plan)
    const ring = slabOutline(scene.data.walls, plan)
    const y = mm(plan.ceiling_mm)
    return [...ring, ring[0]].map(
      ([x, z]) => [x * c, y, z * c] as [number, number, number]
    )
  }, [scene.data])
  if (!pts) return null
  return (
    <group
      position={[placement.x, placement.y, placement.z]}
      rotation={[0, placement.rotY, 0]}
    >
      <Line
        points={pts}
        color={look.wallEdge}
        lineWidth={1}
        dashed
        dashSize={0.4}
        gapSize={0.3}
        transparent
        opacity={0.45}
      />
    </group>
  )
}

type V3 = [number, number, number]

/** A point of a level (its cells, at height `h` m) in the active world. */
function toWorld(
  lv: LevelPlacement,
  plan: ScenePayload["plan"],
  p: [number, number],
  h: number
): V3 {
  const [x, z] = cellToWorld(plan, p[0], p[1])
  const c = Math.cos(lv.rotY)
  const s = Math.sin(lv.rotY)
  // three.js rotation.y: x' = x cos + z sin, z' = -x sin + z cos.
  return [lv.x + x * c + z * s, lv.y + h, lv.z - x * s + z * c]
}

/** The height (m) a stored leg runs at: its first tray's, its own, else
 * under the ceiling. */
function legHeight(
  plan: ScenePayload["plan"],
  leg: { trays: { elevation_mm: number }[]; elevation_mm?: number }
): number {
  if (leg.trays.length) return mm(leg.trays[0].elevation_mm)
  if (leg.elevation_mm != null) return mm(leg.elevation_mm)
  return mm(plan.ceiling_mm - 300)
}

/** One level's part of a cable between floors, from its end to the riser:
 * world points, the riser end last. */
function partToRiser(
  lv: LevelPlacement,
  scene: ScenePayload,
  cp: FloorPlanCablePath
): V3[] | null {
  const path = cp.path
  const riser = path?.riser
  if (!path || !riser) return null
  const t = scene.tiles.find((x) => x.id === riser.tile)
  if (!t) return null
  const rc: [number, number] = [t.x + t.w / 2, t.y + t.h / 2]
  const pts: V3[] = []
  for (const leg of path.legs) {
    const h = legHeight(scene.plan, leg)
    let line = leg.points
    if (!line.length) continue
    const d0 = Math.hypot(line[0][0] - rc[0], line[0][1] - rc[1])
    const d1 = Math.hypot(
      line[line.length - 1][0] - rc[0],
      line[line.length - 1][1] - rc[1]
    )
    if (d0 < d1) line = [...line].reverse()
    pts.push(toWorld(lv, scene.plan, line[0], 0.9))
    for (const p of line) pts.push(toWorld(lv, scene.plan, p, h))
  }
  pts.push(
    toWorld(
      lv,
      scene.plan,
      rc,
      pts.length ? pts[pts.length - 1][1] - lv.y : 0.9
    )
  )
  return pts
}

/** Cables between floors as one run each: this level's part, the climb up
 * or down the riser, and the other level's part - for every pair of shown
 * levels a cable's riser joins. Also the risers' shafts, faint. */
export function RiserRuns({
  levels,
  selectedId,
  onSelect,
}: {
  levels: LevelPlacement[]
  selectedId?: string | null
  onSelect?: (cableId: string) => void
}) {
  const shown = levels.filter((l) => l.look === "active" || l.look === "solid")
  return (
    <>
      {shown.map((lv) => (
        <LevelRiserRuns
          key={lv.floor.id}
          level={lv}
          levels={shown}
          selectedId={selectedId ?? null}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

function LevelRiserRuns({
  level,
  levels,
  selectedId,
  onSelect,
}: {
  level: LevelPlacement
  levels: LevelPlacement[]
  selectedId: string | null
  onSelect?: (cableId: string) => void
}) {
  // Each run is drawn once, from the lower of its two levels.
  const scene = useScene(level.floor.id)
  const paths = useCablePaths(level.floor.id)
  const upper = useMemo(() => {
    const ids = new Set<string>()
    for (const t of scene.data?.tiles ?? [])
      for (const r of t.riser_to ?? []) ids.add(r.floor_plan)
    return levels.filter((l) => ids.has(l.floor.id) && l.index > level.index)
  }, [scene.data, levels, level.index])
  return (
    <>
      {upper.map((other) => (
        <PairRuns
          key={other.floor.id}
          a={level}
          b={other}
          aScene={scene.data}
          aPaths={paths.data?.cables}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

function PairRuns({
  a,
  b,
  aScene,
  aPaths,
  selectedId,
  onSelect,
}: {
  a: LevelPlacement
  b: LevelPlacement
  aScene: ScenePayload | undefined
  aPaths: FloorPlanCablePath[] | undefined
  selectedId: string | null
  onSelect?: (cableId: string) => void
}) {
  const bScene = useScene(b.floor.id)
  const bPaths = useCablePaths(b.floor.id)
  const look = roomLook(useTheme().theme === "dark")
  const { runs, shafts } = useMemo(() => {
    const out: { id: string; color: string; pts: V3[] }[] = []
    const lines: V3[][] = []
    if (!aScene || !bScene.data) return { runs: out, shafts: lines }
    const bTiles = new Map(bScene.data.tiles.map((t) => [t.id, t]))
    for (const t of aScene.tiles) {
      for (const r of t.riser_to ?? []) {
        const u = r.floor_plan === b.floor.id ? bTiles.get(r.id) : null
        if (!u) continue
        lines.push([
          toWorld(a, aScene.plan, [t.x + t.w / 2, t.y + t.h / 2], 0),
          toWorld(b, bScene.data.plan, [u.x + u.w / 2, u.y + u.h / 2], 0),
        ])
      }
    }
    const far = new Map((bPaths.data?.cables ?? []).map((c) => [c.id, c]))
    for (const cp of aPaths ?? []) {
      const pair = cp.path?.riser
      if (!pair) continue
      const other = far.get(cp.id)
      if (!other?.path?.riser) continue
      const pa = partToRiser(a, aScene, cp)
      const pb = partToRiser(b, bScene.data, other)
      if (!pa || !pb) continue
      out.push({
        id: cp.id,
        color: cp.color || "#0ea5e9",
        pts: [...pa, ...[...pb].reverse()],
      })
    }
    return { runs: out, shafts: lines }
  }, [a, b, aScene, aPaths, bScene.data, bPaths.data])
  return (
    <>
      {shafts.map((pts, i) => (
        <Line
          key={`s${i}`}
          points={pts}
          color={look.wallEdge}
          lineWidth={6}
          transparent
          opacity={0.25}
        />
      ))}
      {runs.map((r) => (
        <Line
          key={r.id}
          points={r.pts}
          color={r.color}
          lineWidth={r.id === selectedId ? 4 : 2.5}
          onClick={
            onSelect
              ? (e) => {
                  e.stopPropagation()
                  onSelect(r.id)
                }
              : undefined
          }
        />
      ))}
    </>
  )
}
