import * as THREE from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"

import { jacketRails, transportFrames } from "@/lib/cord-run"
import type { Vec3 } from "@/lib/cord-run"

/** A run's jackets side by side: a zip cord's two or a ribbon's `count`,
 * `pitch` apart, each of `radius` (m). */
export interface JacketsProfile {
  radius: number
  pitch: number
  count: number
  /** The A end's `cable` empty's +Y, the B end's (lib/cord-run frames). */
  startUp: Vec3 | null
  endUp: Vec3 | null
}

/**
 * The jackets of a zip cord or ribbon along `path` as one geometry: each
 * jacket a tube offset along the run's frames' ±X, carried untwisted
 * (lib/cord-run `transportFrames`), centred on the path.
 */
export function jacketsGeometry(
  path: THREE.Curve<THREE.Vector3>,
  segments: number,
  p: JacketsProfile,
  radial = 6
): THREE.BufferGeometry {
  const centre = path
    .getSpacedPoints(segments)
    .map((q) => [q.x, q.y, q.z] as Vec3)
  const frames = transportFrames(centre, p.startUp ?? [0, 1, 0], p.endUp)
  const rails = jacketRails(centre, frames, p.pitch, p.count)
  const tubes = rails.map(
    (rail) =>
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(
          rail.map((q) => new THREE.Vector3(q[0], q[1], q[2]))
        ),
        segments,
        p.radius,
        radial,
        false
      )
  )
  if (tubes.length === 1) return tubes[0]
  const merged = mergeGeometries(tubes) as THREE.BufferGeometry | null
  if (merged) {
    tubes.forEach((t) => t.dispose())
    return merged
  }
  tubes.slice(1).forEach((t) => t.dispose())
  return tubes[0]
}
