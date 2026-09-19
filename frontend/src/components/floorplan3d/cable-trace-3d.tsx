import { useEffect, useMemo, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import * as THREE from "three"

import { isCameraMoving } from "./camera-motion"
import type { Line2 } from "three-stdlib"
import { useQuery } from "@tanstack/react-query"

import { api, type FloorPlanCablePath } from "@/lib/api"
import { findPortMarker, normalizePortName } from "@/lib/faceplate-geometry"
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
  rackOpeningM,
  sideStripBoxM,
  stripPortLocalM,
  syntheticPortMarkers,
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
 * face, then a sideways sweep - clear of the faceplates, at stub depth - to
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
  /** Which face the lead exits - true = rear. Two same-face ends on one rack
   * patch directly; opposite faces must wrap the side, not cut through. */
  rear: boolean
  /** False when no marker matched the port and the lead is anchored on the
   * panel's centre - the card says so, rather than the run looking wrong. */
  anchored: boolean
  /** Rack-LOCAL anchor + tile, so a same-rack run can be routed in local
   * coords (rotation-safe) and transformed once. `chanX` is this end's side
   * channel; `stubZ` is the depth the lead exits to. */
  local: { tile: SceneTile; x: number; y: number; z: number; stubZ: number; chanX: number }
}

/** The traced run draws last and ignores depth - above the glass and ghosts
 * that TRANSPARENT_ORDER sequences, so nothing in the room can hide it. */
const TRACE_ORDER = 10

/** X-ray cables sit above the ghosts/glass but under the active trace. */
const XRAY_CABLE_ORDER = 5

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
  const { width, depth } = rackFootprintM(rack)

  // ── Side-mounted 0U strip (a vertical PDU). No U, so deviceBoxM geometry
  // would be nonsense - anchor on the STRIP instead, at the SAME spot
  // SideStripMesh draws that port's clickable quad (stripPortLocalM is the
  // one layout both consume). Before this, every power cable in the room
  // resolved to null and simply was not drawn.
  if (dev.position == null) {
    if (!dev.mount) return null
    const strip = sideStripBoxM(rack, dev, width, depth)
    const p = stripPortLocalM(strip, dev, point.port)
    const outward = dev.mount === "side_left" ? -1 : 1
    const chanX = outward * (width / 2 + 0.04)
    const stubZ = p.z + p.out * 0.05
    return {
      entry: [
        worldOf(scene, tile, p.x, p.y, p.z),
        worldOf(scene, tile, p.x, p.y, stubZ),
        worldOf(scene, tile, chanX, p.y, stubZ),
      ],
      railAt: (y) => worldOf(scene, tile, chanX, y, stubZ),
      rear: p.out === 1,
      anchored: true,
      local: { tile, x: p.x, y: p.y, z: p.z, stubZ, chanX },
    }
  }

  // Search BOTH panels. The port's own panel decides where the cable lands,
  // not the face the chassis is bolted to - a front-mounted server has its
  // NICs and PSU inlets on its REAR, which is the whole reason hot aisles are
  // where the cabling lives. Keying this off dev.face sent every run to the
  // cold aisle regardless of where the port physically is.
  //
  // Exact name first, then the shared case/spacing-tolerant normalization:
  // imported photo markers routinely disagree with the live component names
  // by case alone ("Psu 1" vs "PSU 1"), and exact-only matching silently
  // dropped those anchors to the middle of the face. Marker names are
  // rendered with the device's stack position: without it a second stack
  // member's `{position}` ports never matched and landed mid-face.
  const find = (panel: "front" | "rear") =>
    findPortMarker(
      dev.image_ports?.[panel] ?? [],
      point.port,
      dev.vc_position ?? null
    )
  const onFront = find("front")
  const m = onFront ?? find("rear")
  // Which of the device's OWN panels we resolved it to. With no marker at all
  // we cannot know, so fall back to the REAR for full-depth gear: that is
  // where a rack server's data and power land. (portLocalM converts the panel
  // to the rack-space side, so rear-mounted gear comes out right too.)
  const portRear = onFront ? false : m != null || dev.is_full_depth
  const box = deviceBoxM(rack, dev, width, depth)
  // A matched marker gives the exact port. Without one, a POWER component
  // still has its synthetic quad - the same row DeviceMesh renders, from the
  // same layout function - so the anchor is a spot you can actually click.
  // Anything else anchors on the middle of the device's panel: not nothing.
  // Returning null here sent the run to a drop at the tile centre, i.e.
  // inside the cabinet, which is why in-rack cables looked like they dived
  // into the middle of the rack and could not be traced.
  const synth = m
    ? undefined
    : syntheticPortMarkers(dev).find(
        (s) => normalizePortName(s.name) === normalizePortName(point.port)
      )
  const panelRear = synth ? true : portRear
  const [lx, ly, lz] = portLocalM(
    box,
    m ?? synth ?? { x: 0.5, y: 0.5 },
    panelRear
  )

  const world = (x: number, y: number, z: number): Vec3 =>
    worldOf(scene, tile, x, y, z)

  // Stub OUT of the face (toward the rack-space side portLocalM resolved the
  // panel to), then sweep sideways at stub depth - clear of every faceplate -
  // to the nearest RAIL edge, and rise there: the corner channel, like a
  // vertical manager bolted to the rail. The channel sits 2 cm outside the
  // rail opening, not outside the cabinet wall: in an 800 mm cabinet the wall
  // is 20 cm past the gear, and a lead dressed out there left the rack in a
  // horseshoe. The riser tucks 3 cm in front of the face, not out in the
  // aisle.
  const outZ = panelRear !== box.mountedRear ? 0.06 : -0.06
  const chanX = (lx >= 0 ? 1 : -1) * (rackOpeningM(rack) / 2 + 0.02)
  const chanZ = lz + outZ * 0.5
  return {
    entry: [
      world(lx, ly, lz),
      world(lx, ly, lz + outZ),
      world(chanX, ly, chanZ),
    ],
    railAt: (y) => world(chanX, y, chanZ),
    rear: panelRear,
    anchored: Boolean(m ?? synth),
    local: { tile, x: lx, y: ly, z: lz, stubZ: lz + outZ, chanX },
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
    return {
      entry: [[x, y, z]],
      railAt: (ry) => [x, ry, z],
      rear: true,
      anchored: false,
      local: { tile: t ?? scene.tiles[0], x: 0, y, z: 0, stubZ: 0, chanX: 0 },
    }
  }

  const A = endRun(cp.a_points, cp.a_tiles[0])
  const B = endRun(cp.b_points, cp.b_tiles[0])

  // Same rack (or same tile). Three shapes:
  //  · SAME face, CLOSE (a PSU→PDU cord, two ports a U apart): a short
  //    direct patch - port → stub → stub → port.
  //  · SAME face, FAR (a switch's front port to a server five U down): the
  //    direct patch became a diagonal across every faceplate in between, so
  //    it takes the corner channel like an installer would - out, over to
  //    the side, down the rail, back in.
  //  · OPPOSITE faces (front↔rear): a straight hop would spear through the
  //    gear, so wrap the SIDE - port → stub → side corner (front depth) →
  //    same-side corner (rear depth) → stub → port.
  // The side is the one nearer the two ports' midpoint (a tie goes to A's),
  // so a lead never wraps the far edge and then crosses the whole face to
  // reach its port. Every run gets its own small lane offset in the channel
  // (the same stagger the trays use), so ten leads down one rail read as
  // ten leads, not one crossing bundle.
  if (cp.a_tiles[0] === cp.b_tiles[0]) {
    const la = A.local
    const lb = B.local
    const w = (x: number, y: number, z: number) =>
      worldOf(scene, la.tile, x, y, z)
    const lane = cableLane(cp.id)
    const far = Math.abs(la.y - lb.y) > 0.15 || Math.abs(la.x - lb.x) > 0.25
    if (A.rear === B.rear && !far) {
      return filletPath(
        [
          w(la.x, la.y, la.z),
          w(la.x, la.y, la.stubZ),
          w(lb.x, lb.y, lb.stubZ),
          w(lb.x, lb.y, lb.z),
        ],
        0.05
      )
    }
    const mid = (la.x + lb.x) / 2
    const sideSign = Math.abs(mid) < 1e-6 ? Math.sign(la.chanX) || 1 : Math.sign(mid)
    const side = sideSign * (Math.abs(la.chanX) + Math.abs(lane.across))
    // Riser depth per end: the stub depth plus the lane's lift, pushed
    // outward from that end's face.
    const outA = Math.sign(la.stubZ - la.z) || 1
    const outB = Math.sign(lb.stubZ - lb.z) || 1
    const zA = la.stubZ + outA * lane.lift
    const zB = lb.stubZ + outB * lane.lift
    if (A.rear === B.rear) {
      return filletPath(
        [
          w(la.x, la.y, la.z),
          w(la.x, la.y, zA),
          w(side, la.y, zA),
          w(side, lb.y, zA),
          w(lb.x, lb.y, zA),
          w(lb.x, lb.y, lb.z),
        ],
        0.06
      )
    }
    // Opposite faces - built in local coords so a rotated rack can't turn
    // "the side" into a diagonal through the gear.
    return filletPath(
      [
        w(la.x, la.y, la.z),
        w(la.x, la.y, zA),
        w(side, la.y, zA),
        w(side, lb.y, zA),
        w(side, lb.y, zB),
        w(lb.x, lb.y, zB),
        w(lb.x, lb.y, lb.z),
      ],
      0.06
    )
  }

  const trays = scene.trays.filter((t) => cp.tray_ids.includes(t.id))
  const areas = scene.raised_floors
  const route = routeCable(
    a,
    b,
    trays.map((t) => t.points)
  )
  // Ride INSIDE the assigned trays - on the basket floor at their (average)
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
  // Hard corners become bends - nobody installs cable at 90°.
  return filletPath(pts, 0.12)
}

/** Whether each end of ``cp`` anchored on a port marker (A, B). An end that
 * did not is drawn at its panel's centre; the cable card says so. */
export function cableEndsAnchored(
  scene: ScenePayload,
  cp: FloorPlanCablePath
): [boolean, boolean] {
  const sites = deviceSites(scene)
  const one = (points: { device: string; port: string }[]) => {
    for (const p of points) {
      const r = portEndRun(scene, sites, p)
      if (r) return r.anchored
    }
    return false
  }
  return [one(cp.a_points), one(cp.b_points)]
}

/** Shared cable-paths fetch - same endpoint + query key as the 2D canvas. */
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
  scale = 1,
}: {
  planId: string
  scene: ScenePayload
  cableId: string
  scale?: number
}) {
  const paths = useCablePaths(planId)
  const cp = paths.data?.cables.find((c) => c.id === cableId)
  const sites = useMemo(() => deviceSites(scene), [scene])
  const points = useMemo(
    () => (cp ? cableRunPoints(scene, sites, cp) : null),
    [cp, scene, sites]
  )
  if (!points) return null
  return (
    <MarchingLine
      points={points}
      color={cp?.color || "#0ea5e9"}
      scale={scale}
    />
  )
}

// ─── All-cables layer ────────────────────────────────────────────────────────

/**
 * Every cable on the plan, drawn port-to-port through its trays - the room's
 * physical cabling at a glance. Hover brightens; click selects (the scene
 * shows the cable card). The actively traced/selected run upgrades to the
 * marching line.
 */
export function CablesLayer({
  planId,
  scene,
  xray = false,
  scale = 1,
  selectedId,
  onSelect,
}: {
  planId: string
  scene: ScenePayload
  /** X-ray shell mode: cables draw through racks - seeing the runs is the
   * point of opening the room up. Solid/cutaway keep physical occlusion. */
  xray?: boolean
  /** Jacket multiplier from the View menu - 1 is life size. */
  scale?: number
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

  // Each run is its own Line2/tube draw call, so a big hall is well over a
  // thousand per frame - the dominant cost while orbiting. Hide the bulk layer
  // WHILE THE CAMERA MOVES (large plans only) and show it again on settle: you
  // can't read an individual cable mid-orbit anyway. group.visible skips the
  // draw without unmounting, so there's nothing to rebuild when it returns.
  // The selected/traced run is exempt - it stays up so a trace never blinks.
  const group = useRef<THREE.Group>(null)
  const shown = useRef(true)
  const invalidate = useThree((s) => s.invalidate)
  const cull = runs.length > MOTION_CULL_LIMIT
  useFrame(() => {
    if (!cull) return
    const want = !isCameraMoving()
    if (want !== shown.current && group.current) {
      shown.current = want
      group.current.visible = want
      invalidate()
    }
  })

  return (
    <>
      {selectedId != null &&
        runs
          .filter((r) => r.cp.id === selectedId)
          .map(({ cp, points }) => (
            <MarchingLine
              key={cp.id}
              points={points}
              color={cp.color || "#0ea5e9"}
              scale={scale}
            />
          ))}
      <group ref={group}>
        {runs.map(({ cp, points }) =>
          cp.id === selectedId ? null : runs.length <= TUBE_LIMIT ? (
            <CableTube
              key={cp.id}
              points={points}
              color={cp.color || CABLE_FALLBACK}
              radius={cableRadiusM(cp.type) * scale}
              xray={xray}
              onClick={() => onSelect(cp.id)}
            />
          ) : (
            <CableLine
              key={cp.id}
              points={points}
              color={cp.color || CABLE_FALLBACK}
              scale={scale}
              xray={xray}
              onClick={() => onSelect(cp.id)}
            />
          )
        )}
      </group>
    </>
  )
}

/** Above this many runs, tubes fall back to cheap lines - geometry for a
 * thousand-cable hall is a loom problem (roadmap P8 follow-up), not a
 * per-cable-mesh problem. */
const TUBE_LIMIT = 200

/** Above this run count, the bulk cable layer hides while the camera moves -
 * each run is its own draw call, so a full hall is the per-frame bottleneck. */
const MOTION_CULL_LIMIT = 300

/**
 * One cable as REAL geometry: a tube with a millimetre jacket radius by kind
 * (power > copper > fibre), lit and AO'd like everything else in the room -
 * a screen-space line neither thickens up close nor sits in the light.
 * Static geometry, demand-frameloop safe; hover glows instead of re-widening.
 */
function CableTube({
  points,
  color,
  radius,
  xray = false,
  onClick,
}: {
  points: [number, number, number][]
  color: string
  radius: number
  xray?: boolean
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
    // The path is already filleted - segments only need to keep up with it.
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
      renderOrder={xray ? XRAY_CABLE_ORDER : 0}
    >
      <meshStandardMaterial
        color={color}
        roughness={0.55}
        emissive={color}
        emissiveIntensity={hovered ? 0.5 : 0}
        depthTest={!xray}
        transparent={xray}
        opacity={xray ? 0.75 : 1}
      />
    </mesh>
  )
}

function CableLine({
  points,
  color,
  scale = 1,
  xray = false,
  onClick,
}: {
  points: [number, number, number][]
  color: string
  scale?: number
  xray?: boolean
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <Line
      points={points}
      color={color}
      lineWidth={(hovered ? 5 : 3.5) * scale}
      transparent
      opacity={xray ? 0.55 : hovered ? 1 : 0.8}
      depthTest={!xray}
      renderOrder={xray ? XRAY_CABLE_ORDER : 0}
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
 * Every animated frame `invalidate()`s the whole demand-frameloop canvas - so
 * a traced cable was re-rendering the entire room (shadows, AO, the lot) at
 * 60–144 Hz. Up close on a High-quality device that tanked the frame rate for
 * a decorative crawl. 30 Hz reads identically and halves the work; the offset
 * still advances by real elapsed time, so the crawl speed is unchanged.
 *
 * The clock is a timer, not `useFrame`: on a demand frameloop a frame
 * callback only runs when a frame is drawn, so a callback that throttled
 * itself and skipped `invalidate()` never asked for the next frame - the
 * crawl froze the moment the camera stopped and only moved while orbiting.
 */
const MARCH_HZ = 30

function MarchingLine({
  points,
  color,
  scale = 1,
}: {
  points: [number, number, number][]
  color: string
  scale?: number
}) {
  const ref = useRef<Line2>(null)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      const mat = ref.current?.material
      if (mat && "dashOffset" in mat) {
        ;(mat as { dashOffset: number }).dashOffset -= dt * 0.6
        invalidate()
      }
    }, 1000 / MARCH_HZ)
    return () => window.clearInterval(id)
  }, [invalidate])
  return (
    <Line
      ref={ref}
      points={points}
      color={color}
      lineWidth={5 * scale}
      dashed
      dashSize={0.25}
      gapSize={0.12}
      // A trace has to be followable through the room, and a run between two
      // rows spends most of its length behind a cabinet. Depth-testing it
      // meant the answer to "where does this cable go" was hidden by the very
      // gear you are asking about. It draws over everything instead, last, so
      // it reads as an overlay on the room rather than an object in it.
      depthTest={false}
      renderOrder={TRACE_ORDER}
    />
  )
}
