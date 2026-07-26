import { useEffect, useMemo, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import * as THREE from "three"
import type { Line2 } from "three-stdlib"
import { useQuery } from "@tanstack/react-query"

import { api, type FloorPlanCablePath } from "@/lib/api"
import { renderTemplateName } from "@/lib/faceplate-geometry"
import { routeCable, type Pt } from "@/components/floorplan/cable-route"

import {
  cableLane,
  cableRadiusM,
  cellToWorld,
  deviceBoxM,
  filletPath,
  freeAirRideY,
  offsetPolyline,
  portLocalM,
  sideStripBoxM,
  rackFootprintM,
  trayElevationM,
  trayRideY,
} from "./world"
import type { ScenePayload, SceneTile } from "./world"

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
 * How a cable LEAVES one end: out of the port quad, a short stub off the
 * face, then a sideways sweep — clear of the faceplates, at stub depth — to
 * the cabinet's NEAREST front corner, where the riser runs like a vertical
 * cable manager hugging the rack edge. (History: v1 jogged across the
 * faceplate AT the face plane and sliced panels; v2 dropped straight down
 * in front of the port and curtained every faceplate below it. The corner
 * channel is how an installer actually dresses a lead.) `entry` is ordered
 * port → stub → corner; `railAt(y)` continues the riser in that column.
 */
interface EndRun {
  entry: Vec3[]
  railAt: (y: number) => Vec3
}

/** Outlet spacing down a vertical PDU strip (m) — about a real C13 pitch, so
 * 24 outlets cover roughly the strip's outlet field. Replace with per-outlet
 * markers once the scene payload carries them. */
const OUTLET_PITCH_M = 0.05

/** Rack-local (x, y, z) → world, applying the tile's centre and orientation.
 * Same transform RackMesh puts on its group. */
function worldOf(
  scene: ScenePayload,
  tile: SceneTile,
  x: number,
  y: number,
  z: number
): Vec3 {
  const [cx, cz] = cellToWorld(
    scene.plan,
    tile.x + tile.w / 2,
    tile.y + tile.h / 2
  )
  const th = (-tile.orientation * Math.PI) / 180
  return [
    cx + x * Math.cos(th) + z * Math.sin(th),
    y,
    cz - x * Math.sin(th) + z * Math.cos(th),
  ]
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
  // Side-mounted strips have no U position — deviceBoxM geometry would be
  // nonsense. Fall back to the tile drop; strip-anchored runs come with the
  // outlet-marker phase.
  const { width, depth } = rackFootprintM(rack)

  // ── Side-mounted 0U strip (a vertical PDU). No U, so deviceBoxM geometry
  // would be nonsense — anchor on the STRIP instead. Outlets are named with a
  // trailing index (C13-01 …), so spread them down the strip at a real C13
  // pitch from the top, clamped inside it. Before this, every power cable in
  // the room resolved to null and simply was not drawn.
  if (dev.position == null) {
    if (!dev.mount) return null
    const strip = sideStripBoxM(rack, dev, width, depth)
    const idx = Number(/(\d+)\s*$/.exec(point.port)?.[1] ?? 0)
    const top = strip.y + strip.h
    const py =
      idx > 0
        ? Math.max(strip.y, top - (idx - 0.5) * OUTLET_PITCH_M)
        : strip.y + strip.h / 2
    const outward = dev.mount === "side_left" ? -1 : 1
    const sx = strip.x + outward * 0.02
    const chanX = outward * (width / 2 + 0.04)
    return {
      entry: [
        [...worldOf(scene, tile, sx, py, strip.z)],
        [...worldOf(scene, tile, chanX, py, strip.z)],
      ] as Vec3[],
      railAt: (y) => worldOf(scene, tile, chanX, y, strip.z),
    }
  }

  const side = dev.face === "rear" ? "rear" : "front"
  const markers = dev.image_ports?.[side] ?? []
  // Markers carry template names; terminations carry rendered ones.
  const m = markers.find(
    (mk) => renderTemplateName(mk.name, null) === point.port
  )
  const box = deviceBoxM(rack, dev, width, depth)
  // A matched marker gives the exact port. WITHOUT one, anchor on the middle
  // of the device's exposed FACE — not nothing. Returning null here sent the
  // run to a drop at the tile centre, i.e. inside the cabinet, which is why
  // in-rack cables looked like they dived into the middle of the rack and
  // could not be traced. A port whose name doesn't match a marker (or a device
  // type with no markers at all) still has a known U and a known face, and
  // landing on the right unit's face is far more use than a hole in the middle.
  const [lx, ly, lz] = m
    ? portLocalM(box, m)
    : [
        box.dx,
        box.y + box.h / 2,
        box.mountedRear
          ? box.dz + box.dd / 2 + 0.004
          : box.dz - box.dd / 2 - 0.004,
      ]

  const world = (x: number, y: number, z: number): Vec3 =>
    worldOf(scene, tile, x, y, z)

  // Stub OUT of the face (local ±Z), then sweep sideways at stub depth —
  // clear of every faceplate — to the nearest cabinet edge, and rise there:
  // the front-corner channel, like a vertical manager bolted to the rail.
  const outZ = box.mountedRear ? 0.12 : -0.12
  const chanX = (lx >= 0 ? 1 : -1) * (width / 2 + 0.04)
  const chanZ = lz + outZ * 0.75 // riser tucks a hair closer to the face
  return {
    entry: [
      world(lx, ly, lz),
      world(lx, ly, lz + outZ),
      world(chanX, ly, chanZ),
    ],
    railAt: (y) => world(chanX, y, chanZ),
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

  // Same rack (or same tile): port → corner → corner → port, no room trip —
  // filleted so the patch lead droops like a lead, not a wire sculpture.
  if (cp.a_tiles[0] === cp.b_tiles[0]) {
    return filletPath([...A.entry, ...[...B.entry].reverse()], 0.08)
  }

  const trays = scene.trays.filter((t) => cp.tray_ids.includes(t.id))
  const areas = scene.raised_floors
  const route = routeCable(
    a,
    b,
    trays.map((t) => t.points)
  )
  // Ride INSIDE the assigned trays — on the basket floor at their (average)
  // elevation, not on the tray datum, which buried every run in the tin.
  // Straight runs with no tray fly at 2/3 room height so they read as an
  // abstract link. Each cable gets a deterministic LANE across the tray and a
  // small height stagger, so ten runs in one duct render as ten parallel runs
  // rather than one overdrawn line.
  const lane = cableLane(cp.id)
  const rideY = trays.length
    ? trayRideY(
        trays.reduce((s, t) => s + trayElevationM(plan, t, areas), 0) /
          trays.length,
        lane.lift
      )
    : freeAirRideY(scene, lane.lift)

  const rideWorld = offsetPolyline(
    route.map((p) => cellToWorld(plan, p[0], p[1])),
    lane.across
  )
  const pts: Vec3[] = []
  pts.push(...A.entry, A.railAt(rideY)) // leave the A port, rise the corner…
  for (const [x, z] of rideWorld) pts.push([x, rideY, z]) // …ride the lane…
  pts.push(B.railAt(rideY), ...[...B.entry].reverse()) // …drop to the B port.
  // Hard corners become bends — nobody installs cable at 90°.
  return filletPath(pts, 0.12)
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
        ) : runs.length <= TUBE_LIMIT ? (
          <CableTube
            key={cp.id}
            points={points}
            color={cp.color || CABLE_FALLBACK}
            radius={cableRadiusM(cp.type)}
            onClick={() => onSelect(cp.id)}
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

/** Above this many runs, tubes fall back to cheap lines — geometry for a
 * thousand-cable hall is a loom problem (roadmap P8 follow-up), not a
 * per-cable-mesh problem. */
const TUBE_LIMIT = 200

/**
 * One cable as REAL geometry: a tube with a millimetre jacket radius by kind
 * (power > copper > fibre), lit and AO'd like everything else in the room —
 * a screen-space line neither thickens up close nor sits in the light.
 * Static geometry, demand-frameloop safe; hover glows instead of re-widening.
 */
function CableTube({
  points,
  color,
  radius,
  onClick,
}: {
  points: [number, number, number][]
  color: string
  radius: number
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const geometry = useMemo(() => {
    const v = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
    const path = new THREE.CurvePath<THREE.Vector3>()
    for (let i = 0; i < v.length - 1; i++)
      path.add(new THREE.LineCurve3(v[i], v[i + 1]))
    let len = 0
    for (let i = 0; i < v.length - 1; i++) len += v[i].distanceTo(v[i + 1])
    // The path is already filleted — segments only need to keep up with it.
    const segments = Math.min(400, Math.max(24, Math.round(len / 0.06)))
    return new THREE.TubeGeometry(path, segments, radius, 6, false)
  }, [points, radius])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh
      geometry={geometry}
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
    >
      <meshStandardMaterial
        color={color}
        roughness={0.55}
        emissive={color}
        emissiveIntensity={hovered ? 0.5 : 0}
      />
    </mesh>
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
      lineWidth={hovered ? 5 : 3.5}
      transparent
      opacity={hovered ? 1 : 0.8}
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

/**
 * The dash crawl runs at this rate, not at display refresh.
 *
 * Every animated frame `invalidate()`s the whole demand-frameloop canvas — so
 * a traced cable was re-rendering the entire room (shadows, AO, the lot) at
 * 60–144 Hz. Up close on a High-quality device that tanked the frame rate for
 * a decorative crawl. 30 Hz reads identically and halves the work; the offset
 * still advances by real elapsed time, so the crawl speed is unchanged.
 */
const MARCH_HZ = 30

function MarchingLine({
  points,
  color,
}: {
  points: [number, number, number][]
  color: string
}) {
  const ref = useRef<Line2>(null)
  const invalidate = useThree((s) => s.invalidate)
  const since = useRef(0)
  useFrame((_, delta) => {
    since.current += delta
    if (since.current < 1 / MARCH_HZ) return
    const mat = ref.current?.material
    if (mat && "dashOffset" in mat) {
      ;(mat as { dashOffset: number }).dashOffset -= since.current * 0.6
      invalidate()
    }
    since.current = 0
  })
  return (
    <Line
      ref={ref}
      points={points}
      color={color}
      lineWidth={5}
      dashed
      dashSize={0.25}
      gapSize={0.12}
    />
  )
}
