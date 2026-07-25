import { useMemo, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import type { Line2 } from "three-stdlib"
import { useQuery } from "@tanstack/react-query"

import { api, type FloorPlanCablePath } from "@/lib/api"
import { renderTemplateName } from "@/lib/faceplate-geometry"
import { routeCable, type Pt } from "@/components/floorplan/cable-route"

import {
  cellToWorld,
  deviceBoxM,
  portLocalM,
  rackFootprintM,
  trayElevationM,
  type ScenePayload,
  type SceneTile,
} from "./world"

/** Fallback tint for cables with no recorded colour. */
const CABLE_FALLBACK = "#64748b"

// ─── Shared run geometry ─────────────────────────────────────────────────────

interface DeviceSite {
  tile: SceneTile
  devIndex: number
}

/** deviceId → its rack tile + device, for port-anchored endpoints. */
function deviceSites(scene: ScenePayload): Map<string, DeviceSite> {
  const map = new Map<string, DeviceSite>()
  for (const tile of scene.tiles) {
    if (!tile.rack) continue
    tile.rack.devices.forEach((d, i) => map.set(d.id, { tile, devIndex: i }))
  }
  return map
}

type Vec3 = [number, number, number]

/**
 * How a cable LEAVES one end: out of the port quad, a short stub straight off
 * the face, then a vertical rise/dive RIGHT THERE, in front of the cabinet at
 * the port's own x — like a patch lead dropping down the front. (An earlier
 * side-rail jog ran horizontally across the faceplate at port height and
 * sliced every panel it passed.) `entry` is ordered port → stub; `railAt(y)`
 * continues the riser in that column.
 */
interface EndRun {
  entry: Vec3[]
  railAt: (y: number) => Vec3
}

/** Resolve one termination to its port-anchored EndRun, or null. */
function portEndRun(
  scene: ScenePayload,
  sites: Map<string, DeviceSite>,
  point: { device: string; port: string }
): EndRun | null {
  const site = sites.get(point.device)
  if (!site?.tile.rack) return null
  const { tile } = site
  const rack = tile.rack!
  const dev = rack.devices[site.devIndex]
  const side = dev.face === "rear" ? "rear" : "front"
  const markers = dev.image_ports?.[side] ?? []
  // Markers carry template names; terminations carry rendered ones.
  const m = markers.find(
    (mk) => renderTemplateName(mk.name, null) === point.port
  )
  if (!m) return null
  const { width, depth } = rackFootprintM(rack)
  const box = deviceBoxM(rack, dev, width, depth)
  const [lx, ly, lz] = portLocalM(box, m)

  // Rack group transform (same as RackMesh): tile centre + orientation.
  const [cx, cz] = cellToWorld(
    scene.plan,
    tile.x + tile.w / 2,
    tile.y + tile.h / 2
  )
  const th = (-tile.orientation * Math.PI) / 180
  const world = (x: number, y: number, z: number): Vec3 => [
    cx + x * Math.cos(th) + z * Math.sin(th),
    y,
    cz - x * Math.sin(th) + z * Math.cos(th),
  ]

  // Stub straight OUT of the face (local ±Z), then rise/dive vertically right
  // there, in front of the cabinet at the port's own x — like a patch lead
  // dropping down the front. (An earlier side-rail jog ran horizontally
  // across the faceplate at port height and sliced every panel it passed.)
  const outZ = box.mountedRear ? 0.18 : -0.18
  return {
    entry: [world(lx, ly, lz), world(lx, ly, lz + outZ)],
    railAt: (y) => world(lx, y, lz + outZ),
  }
}

/**
 * A cable's 3D run: port quad → stub off the face → vertical riser in front
 * of the port → the assigned trays (the same 2D route the flat canvas draws)
 * → down the far riser → the far port. Same-rack cables skip the room trip
 * entirely: stub → stub. Ends fall back to a drop at the endpoint tile when
 * the port can't be anchored (no marker / device not placed). Underfloor
 * rides derive their depth from the raised-floor area beneath the run.
 */
export function cableRunPoints(
  scene: ScenePayload,
  sites: Map<string, DeviceSite>,
  cp: FloorPlanCablePath
): Vec3[] | null {
  const { plan } = scene
  const tileCentre = (tileId: string): Pt | null => {
    const t = scene.tiles.find((x) => x.id === tileId)
    return t ? [t.x + t.w / 2, t.y + t.h / 2] : null
  }
  const a = cp.a_tiles[0] ? tileCentre(cp.a_tiles[0]) : null
  const b = cp.b_tiles[0] ? tileCentre(cp.b_tiles[0]) : null
  if (!a || !b) return null

  const endRun = (
    points: { device: string; port: string }[],
    tileId: string
  ): EndRun => {
    for (const p of points) {
      const r = portEndRun(scene, sites, p)
      if (r) return r
    }
    // Fallback: a plain drop at the endpoint tile's centre.
    const t = scene.tiles.find((x) => x.id === tileId)
    const y = t?.rack ? rackFootprintM(t.rack).height * 0.7 : 0.8
    const [x, z] = cellToWorld(
      plan,
      t ? t.x + t.w / 2 : 0,
      t ? t.y + t.h / 2 : 0
    )
    return { entry: [[x, y, z]], railAt: (ry) => [x, ry, z] }
  }

  const A = endRun(cp.a_points, cp.a_tiles[0])
  const B = endRun(cp.b_points, cp.b_tiles[0])

  // Same rack (or same tile): port → rail → rail → port, no room trip.
  if (cp.a_tiles[0] === cp.b_tiles[0]) {
    return [...A.entry, ...[...B.entry].reverse()]
  }

  const trays = scene.trays.filter((t) => cp.tray_ids.includes(t.id))
  const areas = scene.raised_floors
  const route = routeCable(
    a,
    b,
    trays.map((t) => t.points)
  )
  // Ride at the assigned trays' (average) elevation; straight runs with no
  // tray fly at 2/3 room height so they read as an abstract link.
  const rideY = trays.length
    ? trays.reduce((s, t) => s + trayElevationM(plan, t, areas), 0) /
      trays.length
    : (plan.ceiling_mm / 1000) * 0.66

  const pts: Vec3[] = []
  pts.push(...A.entry, A.railAt(rideY)) // leave the A port, rise the rail…
  for (const p of route) {
    const [x, z] = cellToWorld(plan, p[0], p[1])
    pts.push([x, rideY, z]) // …ride the trays…
  }
  pts.push(B.railAt(rideY), ...[...B.entry].reverse()) // …drop to the B port.
  return pts
}

/** Shared cable-paths fetch — same endpoint + query key as the 2D canvas. */
export function useCablePaths(planId: string) {
  return useQuery({
    queryKey: ["floor-plan-cable-paths", planId],
    queryFn: () =>
      api<{ cables: FloorPlanCablePath[] }>(
        `/api/floor-plans/${planId}/cable-paths/`
      ),
    staleTime: 60_000,
  })
}

// ─── Single-cable trace (?trace= deep link) ──────────────────────────────────

/**
 * A traced cable drawn through the room as an animated marching line, so the
 * run direction reads at a glance.
 */
export function CableTrace3D({
  planId,
  scene,
  cableId,
}: {
  planId: string
  scene: ScenePayload
  cableId: string
}) {
  const paths = useCablePaths(planId)
  const cp = paths.data?.cables.find((c) => c.id === cableId)
  const sites = useMemo(() => deviceSites(scene), [scene])
  const points = useMemo(
    () => (cp ? cableRunPoints(scene, sites, cp) : null),
    [cp, scene, sites]
  )
  if (!points) return null
  return <MarchingLine points={points} color={cp?.color || "#0ea5e9"} />
}

// ─── All-cables layer ────────────────────────────────────────────────────────

/**
 * Every cable on the plan, drawn port-to-port through its trays — the room's
 * physical cabling at a glance. Hover brightens; click selects (the scene
 * shows the cable card). The actively traced/selected run upgrades to the
 * marching line.
 */
export function CablesLayer({
  planId,
  scene,
  selectedId,
  onSelect,
}: {
  planId: string
  scene: ScenePayload
  selectedId: string | null
  onSelect: (cableId: string) => void
}) {
  const paths = useCablePaths(planId)
  const sites = useMemo(() => deviceSites(scene), [scene])
  const runs = useMemo(() => {
    const cables = paths.data?.cables ?? []
    return cables
      .map((cp) => ({ cp, points: cableRunPoints(scene, sites, cp) }))
      .filter(
        (
          r
        ): r is {
          cp: FloorPlanCablePath
          points: [number, number, number][]
        } => Boolean(r.points)
      )
  }, [paths.data, scene, sites])

  return (
    <>
      {runs.map(({ cp, points }) =>
        cp.id === selectedId ? (
          <MarchingLine
            key={cp.id}
            points={points}
            color={cp.color || "#0ea5e9"}
          />
        ) : (
          <CableLine
            key={cp.id}
            points={points}
            color={cp.color || CABLE_FALLBACK}
            onClick={() => onSelect(cp.id)}
          />
        )
      )}
    </>
  )
}

function CableLine({
  points,
  color,
  onClick,
}: {
  points: [number, number, number][]
  color: string
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <Line
      points={points}
      color={color}
      lineWidth={hovered ? 3 : 1.5}
      transparent
      opacity={hovered ? 1 : 0.7}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = ""
      }}
    />
  )
}

function MarchingLine({
  points,
  color,
}: {
  points: [number, number, number][]
  color: string
}) {
  const ref = useRef<Line2>(null)
  const invalidate = useThree((s) => s.invalidate)
  useFrame((_, delta) => {
    const mat = ref.current?.material
    if (mat && "dashOffset" in mat) {
      ;(mat as { dashOffset: number }).dashOffset -= delta * 0.6
      invalidate()
    }
  })
  return (
    <Line
      ref={ref}
      points={points}
      color={color}
      lineWidth={3}
      dashed
      dashSize={0.25}
      gapSize={0.12}
    />
  )
}
