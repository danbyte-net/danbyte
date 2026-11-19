import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { ThreeEvent } from "@react-three/fiber"
import { Html } from "@react-three/drei"
import * as THREE from "three"

import { cordLead, roundCorners } from "@/lib/cord-run"
import type { CordEndStore } from "@/lib/cord-run"
import type { CableWaysMode } from "@/lib/cable-ways-pref"
import type { CableWayStore } from "@/lib/cable-way-store"

import { portLocal } from "./cable-trace-3d"
import { DEVICE_SELECTED } from "./device-mesh"
import { KeepInView } from "./keep-in-view"
import { GHOST_OPACITY } from "./port-plugs"
import { PLUG_RENDER_ORDER } from "./plug-overlay"
import {
  bundles,
  isManager,
  pathwayFills,
  rackFrameM,
  rackLanes,
  rackLocal,
  wayDiameterMm,
  wayLod,
  wayRun,
} from "./way-geometry"
import type {
  EntryGeo,
  ManagerGeo,
  PortAnchor,
  ScenePathway,
  SceneWay,
  Vec3,
  WayRun,
} from "./way-geometry"
import type { SceneRack, Tier } from "./world"

export interface CableWaysScene {
  store: CableWayStore
  onPick?: (cableId: string) => void
  /** The room's cords (port-plugs): a way starts at a drawn cord's lead. */
  cords?: CordEndStore | null
}

export const CableWaysContext = createContext<CableWaysScene | null>(null)

const noSubscribe = () => () => {}
const noVersion = () => 0

/** The picked cable, re-rendering on a change (null without a view). */
export function useWaySelected(): string | null {
  const s = useContext(CableWaysContext)?.store ?? null
  useSyncExternalStore(
    s?.subscribe ?? noSubscribe,
    s?.getVersion ?? noVersion,
    noVersion
  )
  return s?.selected ?? null
}

/** A cable way's colour when its cable records none: the room's grey. */
export const WAY_CABLE_COLOR = "#64748b"
/** Drawn managers and entries without a kit: dark steel. */
const MANAGER_COLOR = "#3f3f46"
const BRUSH_COLOR = "#52525b"
/** Bends no tighter than this (m): a patch cord's, about 4 × its jacket. */
const WAY_BEND_M = 0.022
/** Around a cable up close; a bundle's tube. */
const RADIAL = 6
const BUNDLE_RADIAL = 10
/** Ghosted ways, and the rest while one is picked. */
const PICK_GHOST = 0.12

interface Drawn {
  way: SceneWay
  run: WayRun
  dia: number
  color: string
}

/**
 * One rack's cable ways, in the rack group's frame (rack-mesh): each
 * stored way drawn along its pathways - recorded ones solid, proposed ones
 * see-through (never counted until accepted) - every cable of the rack in
 * one merged mesh up close, one bundle per manager further off
 * (`wayLod`). Ghost draws them all see-through; Hide draws none. Its
 * managers and entries are drawn here when the rack has no kit model to
 * draw them (rack-kit does), and coloured by `fill` (indicative).
 * Nothing runs per frame: the geometry is built when the ways, the cords
 * at their ports or the choices change.
 */
export function RackCableWays({
  rack,
  tier,
  mode,
  fill,
  kitDrawn,
  toLocal,
}: {
  rack: SceneRack
  tier: Tier
  mode: CableWaysMode
  fill: boolean
  /** The rack's kit model draws its own managers and entries. */
  kitDrawn: boolean
  /** World → this rack's frame, for the cords' leads (the room's). */
  toLocal?: (p: Vec3) => Vec3
}) {
  const ctx = useContext(CableWaysContext)
  const cords = ctx?.cords ?? null
  const cordVersion = useSyncExternalStore(
    cords?.subscribe ?? noSubscribe,
    cords?.getVersion ?? noVersion,
    noVersion
  )
  const selected = useWaySelected()
  const { depthM: depth, heightM: height, baseM, topUnitM } = rackFrameM(rack)
  const pathways = useMemo(
    () => new Map((rack.pathways ?? []).map((p) => [p.key, p])),
    [rack.pathways]
  )
  const ways = rack.ways ?? NO_WAYS
  const lanes = useMemo(() => rackLanes(pathways, ways), [pathways, ways])
  const drawn = useMemo(() => {
    const devices = new Map(rack.devices.map((d) => [d.id, d]))
    const anchor = (
      end: SceneWay["ends"][number] | undefined
    ): PortAnchor | null => {
      if (!end) return null
      const cord = cords?.get(end.device, end.port) ?? null
      if (cord && toLocal) {
        const [at, lead] = cordLead(cord)
        return { p: toLocal(at), stub: toLocal(lead) }
      }
      const dev = devices.get(end.device)
      if (!dev) return null
      const at = portLocal(rack, dev, end.port)
      return at ? { p: at.p, stub: at.stub } : null
    }
    const out: Drawn[] = []
    for (const way of ways) {
      const a = way.ends.find((e) => e.end === "A")
      const b = way.ends.find((e) => e.end === "B")
      const start = anchor(way.end === "B" ? b : a)
      if (!start) continue
      const far = way.end === "AB" ? anchor(b) : null
      if (way.exit === "port" && !far) continue
      const run = wayRun({
        depthM: depth,
        heightM: height,
        baseM,
        topUnitM,
        pathways,
        way,
        lanes,
        start,
        far,
      })
      out.push({
        way,
        run,
        dia: wayDiameterMm(way.type, way.outer_diameter_mm),
        color: way.color || WAY_CABLE_COLOR,
      })
    }
    return out
    // `cordVersion` stands for what `cords` holds.
  }, [
    rack,
    ways,
    pathways,
    lanes,
    cords,
    cordVersion,
    toLocal,
    depth,
    height,
    baseM,
    topUnitM,
  ])

  const fills = useMemo(
    () => (fill ? pathwayFills(pathways, ways) : null),
    [fill, pathways, ways]
  )
  const lod = wayLod(tier)
  const pick = (cableId: string) =>
    ctx?.onPick ? ctx.onPick(cableId) : ctx?.store.toggle(cableId)
  const picked =
    selected != null ? drawn.find((d) => d.way.cable_id === selected) : null

  return (
    <group>
      {tier === "detail" && (
        <OwnPathways
          pathways={pathways}
          depth={depth}
          fills={fills}
          skipKit={kitDrawn}
        />
      )}
      {kitDrawn && tier === "detail" && fills && (
        <FillMarks pathways={pathways} depth={depth} fills={fills} />
      )}
      {mode !== "hide" &&
        (lod === "cables" ? (
          <WayCables
            drawn={drawn}
            ghostAll={mode === "ghost"}
            dim={selected != null}
            onPick={pick}
          />
        ) : (
          <WayBundles
            depth={depth}
            pathways={pathways}
            drawn={drawn}
            dim={selected != null}
          />
        ))}
      {mode !== "hide" && picked && <PickedWay drawn={picked} />}
    </group>
  )
}

const NO_WAYS: SceneWay[] = []

// ── cables up close: one merged mesh ────────────────────────────────────────

/** Triangles of the merged mesh per cable, for picking. */
interface Range {
  start: number
  end: number
  cableId: string
}

/** A tube along a polyline (its corners already rounded): one ring per
 * point, its frame carried along (no twist), into `out` with `color`. */
export function tubeInto(
  points: readonly Vec3[],
  radius: number,
  radial: number,
  color: THREE.Color,
  out: { pos: number[]; nrm: number[]; col: number[]; idx: number[] }
): void {
  if (points.length < 2) return
  const base = out.pos.length / 3
  const v = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
  const tangents = v.map((_, i) => {
    const a = v[Math.max(0, i - 1)]
    const b = v[Math.min(v.length - 1, i + 1)]
    return b.clone().sub(a).normalize()
  })
  // The first normal: any axis not along the first tangent.
  const t0 = tangents[0]
  const seed =
    Math.abs(t0.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0)
  let n = new THREE.Vector3().crossVectors(t0, seed).normalize()
  const ring = new THREE.Vector3()
  for (let i = 0; i < v.length; i++) {
    const t = tangents[i]
    if (i > 0) {
      // Parallel transport: turn the normal as the tangent turns.
      const prev = tangents[i - 1]
      const axis = new THREE.Vector3().crossVectors(prev, t)
      const s = axis.length()
      if (s > 1e-6) {
        const ang = Math.atan2(s, prev.dot(t))
        n.applyAxisAngle(axis.normalize(), ang)
      }
      n = n.sub(t.clone().multiplyScalar(n.dot(t))).normalize()
    }
    const b = new THREE.Vector3().crossVectors(t, n)
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2
      ring.copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a))
      out.nrm.push(ring.x, ring.y, ring.z)
      out.pos.push(
        v[i].x + ring.x * radius,
        v[i].y + ring.y * radius,
        v[i].z + ring.z * radius
      )
      out.col.push(color.r, color.g, color.b)
    }
  }
  for (let i = 0; i < v.length - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = base + i * radial + k
      const b2 = base + i * radial + ((k + 1) % radial)
      const c = a + radial
      const d = b2 + radial
      out.idx.push(a, c, b2, b2, c, d)
    }
  }
}

function buildMerged(
  drawn: readonly Drawn[],
  want: (d: Drawn) => boolean
): { geometry: THREE.BufferGeometry; ranges: Range[] } | null {
  const out = {
    pos: [] as number[],
    nrm: [] as number[],
    col: [] as number[],
    idx: [] as number[],
  }
  const ranges: Range[] = []
  const c = new THREE.Color()
  for (const d of drawn) {
    if (!want(d)) continue
    const start = out.idx.length / 3
    const pts = roundCorners(d.run.points, WAY_BEND_M)
    c.set(d.color)
    tubeInto(pts, d.dia / 2000, RADIAL, c, out)
    ranges.push({ start, end: out.idx.length / 3, cableId: d.way.cable_id })
  }
  if (!out.idx.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(out.nrm, 3))
  g.setAttribute("color", new THREE.Float32BufferAttribute(out.col, 3))
  g.setIndex(out.idx)
  g.computeBoundingSphere()
  return { geometry: g, ranges }
}

/** The cable a picked triangle belongs to. */
export function rangeAt(ranges: readonly Range[], face: number): string | null {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (face < r.start) hi = mid - 1
    else if (face >= r.end) lo = mid + 1
    else return r.cableId
  }
  return null
}

function WayCables({
  drawn,
  ghostAll,
  dim,
  onPick,
}: {
  drawn: readonly Drawn[]
  ghostAll: boolean
  dim: boolean
  onPick: (cableId: string) => void
}) {
  // Recorded ways solid (Show), proposed ones see-through always.
  const solid = useMemo(
    () =>
      ghostAll ? null : buildMerged(drawn, (d) => d.way.state === "recorded"),
    [drawn, ghostAll]
  )
  const ghost = useMemo(
    () => buildMerged(drawn, (d) => ghostAll || d.way.state !== "recorded"),
    [drawn, ghostAll]
  )
  useEffect(() => () => solid?.geometry.dispose(), [solid])
  useEffect(() => () => ghost?.geometry.dispose(), [ghost])
  const [hover, setHover] = useState<{ at: Vec3; cableId: string } | null>(null)
  const byId = useMemo(
    () => new Map(drawn.map((d) => [d.way.cable_id, d])),
    [drawn]
  )
  const handlers = (ranges: Range[]) => ({
    onClick: (e: ThreeEvent<MouseEvent>) => {
      const id = e.faceIndex != null ? rangeAt(ranges, e.faceIndex) : null
      if (!id) return
      e.stopPropagation()
      onPick(id)
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      const id = e.faceIndex != null ? rangeAt(ranges, e.faceIndex) : null
      if (!id) return
      e.stopPropagation()
      document.body.style.cursor = "pointer"
      if (hover?.cableId !== id) {
        const p = e.object.worldToLocal(e.point.clone())
        setHover({ at: [p.x, p.y, p.z], cableId: id })
      }
    },
    onPointerOut: () => {
      document.body.style.cursor = ""
      setHover(null)
    },
  })
  const hovered = hover ? byId.get(hover.cableId) : null
  return (
    <>
      {solid && (
        <mesh
          geometry={solid.geometry}
          castShadow={!dim}
          {...handlers(solid.ranges)}
        >
          <meshStandardMaterial
            key={dim ? "dim" : "solid"}
            vertexColors
            roughness={0.6}
            metalness={0.05}
            transparent={dim}
            opacity={dim ? PICK_GHOST : 1}
            depthWrite={!dim}
          />
        </mesh>
      )}
      {ghost && (
        <mesh
          geometry={ghost.geometry}
          renderOrder={PLUG_RENDER_ORDER}
          {...handlers(ghost.ranges)}
        >
          <meshStandardMaterial
            vertexColors
            roughness={0.6}
            transparent
            opacity={dim ? PICK_GHOST : GHOST_OPACITY}
            depthWrite={false}
          />
        </mesh>
      )}
      {hovered && hover && (
        <Html
          position={hover.at}
          zIndexRange={[20, 0]}
          style={{ pointerEvents: "none" }}
        >
          <KeepInView>
            <div className="ml-3 -translate-y-1/2 rounded-md border border-border bg-popover/95 px-2 py-1.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-md">
              <div className="font-semibold">
                {hovered.way.label || "Cable"}
              </div>
              <div className="font-mono text-muted-foreground">
                {hovered.way.ends.map((e) => e.port).join(" · ")}
              </div>
              {hovered.way.state !== "recorded" && (
                <div className="text-muted-foreground">Proposed way</div>
              )}
            </div>
          </KeepInView>
        </Html>
      )}
    </>
  )
}

/** The picked cable's way, solid in the selection colour over everything
 * ghosted round it. */
function PickedWay({ drawn }: { drawn: Drawn }) {
  const geometry = useMemo(
    () => buildMerged([drawn], () => true)?.geometry ?? null,
    [drawn]
  )
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} renderOrder={PLUG_RENDER_ORDER + 1}>
      <meshStandardMaterial
        color={DEVICE_SELECTED}
        emissive={DEVICE_SELECTED}
        emissiveIntensity={0.45}
        roughness={0.5}
      />
    </mesh>
  )
}

// ── further off: one bundle per manager ─────────────────────────────────────

function WayBundles({
  depth,
  pathways,
  drawn,
  dim,
}: {
  depth: number
  pathways: ReadonlyMap<string, ScenePathway>
  drawn: readonly Drawn[]
  dim: boolean
}) {
  const list = useMemo(
    () =>
      bundles(
        depth,
        pathways,
        drawn.map((d) => ({ spans: d.run.spans, dia: d.dia, color: d.color }))
      ),
    [depth, pathways, drawn]
  )
  const ref = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(
    () => new THREE.CylinderGeometry(1, 1, 1, BUNDLE_RADIAL, 1, false),
    []
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const mat = new THREE.Matrix4()
    const c = new THREE.Color()
    list.forEach((b, i) => {
      mat.makeScale(b.radius, Math.max(b.y1 - b.y0, 0.01), b.radius)
      mat.setPosition(b.at[0], (b.y0 + b.y1) / 2, b.at[1])
      m.setMatrixAt(i, mat)
      m.setColorAt(i, c.set(b.color))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [list])
  if (!list.length) return null
  return (
    <instancedMesh
      key={list.length}
      ref={ref}
      args={[geometry, undefined, list.length]}
      raycast={() => null}
    >
      <meshStandardMaterial
        roughness={0.7}
        transparent={dim}
        opacity={dim ? PICK_GHOST : 1}
        depthWrite={!dim}
      />
    </instancedMesh>
  )
}

// ── managers and entries without a kit ──────────────────────────────────────

/**
 * A rack's managers and entries drawn in Danbyte's own style, where no kit
 * model draws them: a vertical manager as a thin-walled channel open on
 * the side its cables enter (`open`), with fingers at its pitch when it is
 * a finger manager or D-ring; an entry as a framed opening with its brush
 * on the roof or the floor. Coloured by the fill overlay when it is on.
 */
function OwnPathways({
  pathways,
  depth,
  fills,
  skipKit,
}: {
  pathways: ReadonlyMap<string, ScenePathway>
  depth: number
  fills: ReadonlyMap<string, string> | null
  /** The kit's model draws its own pathways: only the others here. */
  skipKit: boolean
}) {
  const boxes = useMemo(() => {
    const own = skipKit
      ? new Map([...pathways].filter(([, p]) => p.source !== "kit"))
      : pathways
    return ownBoxes(own, depth, fills)
  }, [pathways, depth, fills, skipKit])
  return <Boxes boxes={boxes} />
}

/** Over a kit's managers with the fill overlay on: a thin coloured strip
 * along each manager's open edge, so the kit's own model keeps its look. */
function FillMarks({
  pathways,
  depth,
  fills,
}: {
  pathways: ReadonlyMap<string, ScenePathway>
  depth: number
  fills: ReadonlyMap<string, string>
}) {
  const boxes = useMemo(() => {
    const out: Box[] = []
    for (const p of pathways.values()) {
      const color = fills.get(p.key)
      if (!color || p.kind !== "vertical") continue
      const g = p.geo as ManagerGeo
      const [x0, , z0] = rackLocal(depth, g.x0, g.y0, 0)
      const [x1, , z1] = rackLocal(depth, g.x1, g.y1, 0)
      const front = Math.min(z0, z1)
      out.push({
        c: [(x0 + x1) / 2, (g.z0 + g.z1) / 2000, front - 0.004],
        s: [Math.abs(x1 - x0), (g.z1 - g.z0) / 1000, 0.004],
        color,
        glow: true,
      })
    }
    return out
  }, [pathways, depth, fills])
  return <Boxes boxes={boxes} />
}

interface Box {
  c: Vec3
  s: Vec3
  color: string
  glow?: boolean
}

/** The boxes of `OwnPathways` (rack frame, m). */
export function ownBoxes(
  pathways: ReadonlyMap<string, ScenePathway>,
  depth: number,
  fills: ReadonlyMap<string, string> | null
): Box[] {
  const out: Box[] = []
  const T = 0.0015
  for (const p of pathways.values()) {
    const color = fills?.get(p.key) ?? MANAGER_COLOR
    if (p.kind === "vertical" && isManager(p)) {
      const g = p.geo
      const [xa, , za] = rackLocal(depth, g.x0, g.y0, 0)
      const [xb, , zb] = rackLocal(depth, g.x1, g.y1, 0)
      const x0 = Math.min(xa, xb)
      const x1 = Math.max(xa, xb)
      const z0 = Math.min(za, zb)
      const z1 = Math.max(za, zb)
      const y0 = g.z0 / 1000
      const y1 = g.z1 / 1000
      const h = y1 - y0
      const cy = (y0 + y1) / 2
      const w = x1 - x0
      const d = z1 - z0
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      // The rack frame's +x is the rack's left: the gear side of a left
      // manager is its -x face.
      const towardGear = p.side === "left" ? -1 : 1
      const open = g.open
      const walls: Box[] = []
      if (open !== "front")
        walls.push({ c: [cx, cy, z0 + T / 2], s: [w, h, T], color })
      if (open !== "rear")
        walls.push({ c: [cx, cy, z1 - T / 2], s: [w, h, T], color })
      if (open !== "inner")
        walls.push({
          c: [cx + (towardGear * (w - T)) / 2, cy, cz],
          s: [T, h, d],
          color,
        })
      if (open !== "outer")
        walls.push({
          c: [cx - (towardGear * (w - T)) / 2, cy, cz],
          s: [T, h, d],
          color,
        })
      out.push(...walls)
      if (g.pitch_mm && (p.subkind === "finger" || p.subkind === "d-ring")) {
        // Fingers along the open edge, one per pitch.
        const pitch = g.pitch_mm / 1000
        const n = Math.max(1, Math.floor(h / pitch))
        const fz = open === "rear" ? z1 : z0
        for (let i = 0; i < n; i++) {
          const y = y0 + (i + 0.5) * pitch
          for (const sx of [-1, 1])
            out.push({
              c: [cx + (sx * (w - 0.006)) / 2, y, fz],
              s: [0.006, pitch * 0.35, 0.02],
              color,
            })
        }
      }
    } else if (p.kind === "entry") {
      const g = p.geo as EntryGeo
      const [x, y, z] = rackLocal(depth, g.x, g.y, g.z)
      const w = g.w / 1000
      const d = g.d / 1000
      const lift = p.surface === "bottom" ? 0.002 : 0.003
      const yy = p.surface === "bottom" ? y + lift : y + lift
      out.push(
        { c: [x, yy, z - d / 2], s: [w, 0.004, 0.008], color },
        { c: [x, yy, z + d / 2], s: [w, 0.004, 0.008], color },
        { c: [x - w / 2, yy, z], s: [0.008, 0.004, d], color },
        { c: [x + w / 2, yy, z], s: [0.008, 0.004, d], color },
        {
          c: [x, yy - 0.001, z],
          s: [w - 0.008, 0.002, d * 0.25],
          color: BRUSH_COLOR,
        }
      )
    }
  }
  return out
}

function Boxes({ boxes }: { boxes: readonly Box[] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const mat = new THREE.Matrix4()
    const c = new THREE.Color()
    boxes.forEach((b, i) => {
      mat.makeScale(b.s[0], b.s[1], b.s[2])
      mat.setPosition(b.c[0], b.c[1], b.c[2])
      m.setMatrixAt(i, mat)
      m.setColorAt(i, c.set(b.color))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [boxes])
  if (!boxes.length) return null
  return (
    <instancedMesh
      key={boxes.length}
      ref={ref}
      args={[geometry, undefined, boxes.length]}
      castShadow
      receiveShadow
      raycast={() => null}
    >
      <meshStandardMaterial roughness={0.6} metalness={0.3} />
    </instancedMesh>
  )
}
