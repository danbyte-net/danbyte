import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import type { Pt, RaisedRegion } from "../floorplan/raised-floor-shape"
import { cellToWorld, mm } from "./world"
import type { ScenePayload } from "./world"

// Mostly render-only construction geometry (owner's rule: build in 2D, view
// in 3D) - the one interaction is the VIEW action of lifting a floor: click
// a pad's edge skirt to peek into its plenum. Heights are small, so both
// LOD tiers can afford the few meshes per pad.

/** Top-slab elevations, just above the room's grid lines (0.002/0.004). */
const TOP_Y = 0.006
const TOP_THICKNESS = 0.012
/** The finished floor's surface - world.ts's RAISED_FLOOR_TOP_M less the
 * tile grid's hair. */
const SURFACE_Y = TOP_Y + TOP_THICKNESS / 2
/** Standard raised-floor tile pitch (m) - the grid every operator addresses. */
const TILE_M = 0.6
/** Finished-floor opacity at rest, and lifted for the plenum peek. */
const OPACITY_SOLID = 0.92
const OPACITY_PEEK = 0.14

/** A flat surface over the pieces (world x/z), one geometry. */
function surface(pieces: readonly Pt[][]): THREE.BufferGeometry {
  const pos: number[] = []
  for (const piece of pieces) {
    const contour = piece.map(([x, z]) => new THREE.Vector2(x, z))
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, []))
      for (const i of [a, b, c]) pos.push(contour[i].x, 0, contour[i].y)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  const normals = new Array<number>(pos.length)
  for (let i = 0; i < pos.length; i += 3) {
    normals[i] = 0
    normals[i + 1] = 1
    normals[i + 2] = 0
  }
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
  return g
}

/** Vertical quads along the outer boundary, from `top` down to `bottom`. */
function skirts(
  outline: readonly Pt[][],
  top: number,
  bottom: number
): THREE.BufferGeometry {
  const pos: number[] = []
  for (const line of outline)
    for (let i = 0; i < line.length - 1; i++) {
      const [x0, z0] = line[i]
      const [x1, z1] = line[i + 1]
      pos.push(
        ...[x0, top, z0, x1, top, z1, x1, bottom, z1],
        ...[x0, top, z0, x1, bottom, z1, x0, bottom, z0]
      )
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

/**
 * The 600 mm tile grid over the pieces (world x/z): lines along the pad's
 * longest outer edge and across it, from that edge's start, each cut to the
 * pieces - a turned hall's tiles turn with it.
 */
export function tileGrid(
  pieces: readonly Pt[][],
  outline: readonly Pt[][],
  pitch = TILE_M
): number[] {
  let best: [Pt, Pt] | null = null
  let bestLen = 0
  for (const line of outline)
    for (let i = 0; i < line.length - 1; i++) {
      const len = Math.hypot(
        line[i + 1][0] - line[i][0],
        line[i + 1][1] - line[i][1]
      )
      if (len > bestLen) {
        bestLen = len
        best = [line[i], line[i + 1]]
      }
    }
  if (!best) return []
  const origin = best[0]
  const ux = (best[1][0] - origin[0]) / bestLen
  const uz = (best[1][1] - origin[1]) / bestLen
  // (u, v): along the edge, and across it.
  const toUV = ([x, z]: Pt): Pt => {
    const dx = x - origin[0]
    const dz = z - origin[1]
    return [dx * ux + dz * uz, -dx * uz + dz * ux]
  }
  const toXZ = (u: number, v: number): Pt => [
    origin[0] + u * ux - v * uz,
    origin[1] + u * uz + v * ux,
  ]
  const uvPieces = pieces.map((p) => p.map(toUV))
  const all = uvPieces.flat()
  const out: number[] = []
  // Lines of constant `axis` (0: u, 1: v) at each pitch inside the span.
  for (const axis of [0, 1] as const) {
    const other = axis === 0 ? 1 : 0
    const lo = Math.min(...all.map((p) => p[axis]))
    const hi = Math.max(...all.map((p) => p[axis]))
    for (
      let c = Math.ceil((lo + 1e-6) / pitch) * pitch;
      c < hi - 1e-6;
      c += pitch
    ) {
      for (const poly of uvPieces) {
        const hits: number[] = []
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]
          const b = poly[(i + 1) % poly.length]
          if (a[axis] > c !== b[axis] > c) {
            const t = (c - a[axis]) / (b[axis] - a[axis])
            hits.push(a[other] + t * (b[other] - a[other]))
          }
        }
        hits.sort((p, q) => p - q)
        for (let i = 0; i + 1 < hits.length; i += 2) {
          const p0 = axis === 0 ? toXZ(c, hits[i]) : toXZ(hits[i], c)
          const p1 = axis === 0 ? toXZ(c, hits[i + 1]) : toXZ(hits[i + 1], c)
          out.push(p0[0], 0, p0[1], p1[0], 0, p1[1])
        }
      }
    }
  }
  return out
}

/**
 * One raised-floor pad - touching raised floors of one depth and colour
 * (raised-floor-shape.ts's region): one finished-floor surface with its
 * 600 mm tile grid, skirts along its outer edge only, dropping to the
 * structural slab at −plenum, and a dark plenum bottom. `peek` (global
 * toggle, x-ray, or this pad lifted by clicking its skirt) fades the top
 * over ~0.4 s so the underfloor trays and cable runs read through the void
 * they live in - the fade animates on the demand frameloop by invalidating
 * only while it is actually moving.
 */
export function RaisedFloorMesh({
  plan,
  region,
  peek,
  onToggleLift,
}: {
  plan: ScenePayload["plan"]
  region: RaisedRegion<{ id: string }>
  peek: boolean
  /** Click on the pad's edge skirt - the per-pad lift. */
  onToggleLift?: (areaIds: string[]) => void
}) {
  const depth = mm(region.plenum_mm)
  const tint = region.color || "#3f3f46"
  const ids = region.rows.map((r) => r.id)

  const geo = useMemo(() => {
    const w = (p: Pt): Pt => cellToWorld(plan, p[0], p[1])
    const pieces = region.pieces.map((p) => p.map(w))
    const outline = region.outline.map((l) => l.map(w))
    const grid = new THREE.BufferGeometry()
    grid.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(tileGrid(pieces, outline), 3)
    )
    return {
      top: surface(pieces),
      bottom: surface(pieces),
      skirt: skirts(outline, SURFACE_Y, -depth),
      grid,
    }
  }, [plan, region, depth])
  useEffect(
    () => () => {
      geo.top.dispose()
      geo.bottom.dispose()
      geo.skirt.dispose()
      geo.grid.dispose()
    },
    [geo]
  )

  // The lift animates the top's opacity toward its target; frames are
  // demanded only while the value is still moving.
  const topMat = useRef<THREE.MeshStandardMaterial>(null)
  const invalidate = useThree((s) => s.invalidate)
  useFrame((_, dt) => {
    const m = topMat.current
    if (!m) return
    const target = peek ? OPACITY_PEEK : OPACITY_SOLID
    const diff = target - m.opacity
    if (Math.abs(diff) < 0.01) {
      if (m.opacity !== target) {
        m.opacity = target
        // Solid floors write depth so the plenum is genuinely hidden -
        // the honest render of a closed floor.
        m.depthWrite = !peek
      }
      return
    }
    m.opacity += diff * Math.min(1, dt * 8)
    m.depthWrite = false
    invalidate()
  })

  return (
    <group>
      {/* Finished floor. */}
      <mesh
        geometry={geo.top}
        position={[0, SURFACE_Y, 0]}
        raycast={() => null}
        receiveShadow
      >
        <meshStandardMaterial
          ref={topMat}
          color={tint}
          roughness={0.9}
          transparent
          opacity={peek ? OPACITY_PEEK : OPACITY_SOLID}
          depthWrite={!peek}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Tile grid, a hair above the finished floor. */}
      <lineSegments
        geometry={geo.grid}
        position={[0, SURFACE_Y + 0.001, 0]}
        raycast={() => null}
      >
        <lineBasicMaterial color="#18181b" transparent opacity={0.4} />
      </lineSegments>
      {/* Plenum bottom - the structural slab. */}
      <mesh
        geometry={geo.bottom}
        position={[0, -depth, 0]}
        raycast={() => null}
      >
        <meshStandardMaterial
          color="#18181b"
          roughness={1}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Skirts along the outer edge only: the pad's visible edge, and the
          lift's click target - clicking the TOP would steal every deselect
          click on the pad. */}
      <mesh
        geometry={geo.skirt}
        onClick={
          onToggleLift
            ? (e) => {
                e.stopPropagation()
                onToggleLift(ids)
              }
            : undefined
        }
        onPointerOver={
          onToggleLift
            ? (e) => {
                e.stopPropagation()
                document.body.style.cursor = "pointer"
              }
            : undefined
        }
        onPointerOut={
          onToggleLift
            ? () => {
                document.body.style.cursor = ""
              }
            : undefined
        }
      >
        <meshStandardMaterial
          color={tint}
          roughness={0.9}
          transparent
          opacity={peek ? 0.25 : 0.5}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  )
}
