import * as THREE from "three"

import { findPortMarker } from "@/lib/faceplate-geometry"
import {
  denormalisePoint,
  fittedSize,
  portFromHit,
  portLocal,
} from "@/lib/model-ports"
import type { ModelPort, ModelPortsDoc, V3 } from "@/lib/model-ports"

import { modelRotation, modelScale, modelTargetM, tileWorldPose } from "./world"
import type {
  ScenePayload,
  SceneFloorDevice,
  SceneModel,
  SceneTile,
} from "./world"

/**
 * Where a floor-placed device's mapped model ports stand in the room, with
 * no model loaded: the mapping's `bounds` is the model's upright size, and
 * the room fits it by the same uniform scale `fittedModel` gives - so a
 * cable ends at its port from the first frame, and the markers drawn on the
 * loaded model land on the same spots.
 */

/** The tile's footprint in its own (unrotated) frame (m) - what a model
 * with no measured size is fitted into (`placedOf` gives the same). */
export function tileFootprintM(
  plan: ScenePayload["plan"],
  tile: Pick<SceneTile, "w" | "h" | "orientation">
): { w: number; d: number } {
  return tileWorldPose(plan, { x: 0, y: 0, ...tile }).local
}

/** The fitted model's upright size (m) from its mapping's bounds. */
export function mappedModelSizeM(
  dev: Pick<SceneFloorDevice, "width_mm" | "height_mm" | "depth_mm" | "model">,
  doc: Pick<ModelPortsDoc, "bounds">,
  footprint: { w: number; d: number } | null
): V3 {
  const scale = modelScale(
    doc.bounds,
    modelTargetM(dev, footprint),
    dev.model?.fit ?? "auto"
  )
  return fittedSize(doc.bounds, scale)
}

/** The mapped port a cable end names, by the device's real port name -
 * the mapping keeps template names, `{position}` and case tolerant, as a
 * photo marker matches. */
export function findModelPort(
  dev: Pick<SceneFloorDevice, "model_ports" | "vc_position" | "model">,
  port: string
): ModelPort | undefined {
  if (!dev.model || !dev.model_ports) return undefined
  return findPortMarker(dev.model_ports.ports, port, dev.vc_position ?? null)
}

/**
 * A mapped port local to its tile (m, y from the floor under it), and its
 * outward normal in the same frame: the device's group stands the fitted
 * model centred on the tile, front on local −Z.
 */
export function floorModelPortLocal(
  scene: Pick<ScenePayload, "plan">,
  tile: SceneTile,
  dev: SceneFloorDevice,
  port: ModelPort
): { at: V3; normal: V3 } | null {
  if (!dev.model_ports) return null
  const size = mappedModelSizeM(
    dev,
    dev.model_ports,
    tileFootprintM(scene.plan, tile)
  )
  return { at: portLocal(port.p, size), normal: port.n }
}

// ─── The editor's surface maths ──────────────────────────────────────────────

/** The model as the editor holds it: upright, centred on the origin. */
export interface Upright {
  object: THREE.Object3D
  rotation: THREE.Euler
  /** Upright box, in model units. */
  min: V3
  max: V3
  center: V3
  size: V3
}

/** A model stood upright as the room stands it (`up`/`front`), with its
 * upright box. */
export function uprightOf(
  scene: THREE.Object3D,
  up: SceneModel["up"],
  front: SceneModel["front"]
): Upright {
  const object = scene.clone(true)
  const [rx, ry, rz] = modelRotation(up, front)
  const rotation = new THREE.Euler(rx, ry, rz, "YXZ")
  object.updateMatrixWorld(true)
  const box = new THREE.Box3()
    .setFromObject(object)
    .applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rotation))
  const c = box.getCenter(new THREE.Vector3())
  const s = box.getSize(new THREE.Vector3())
  return {
    object,
    rotation,
    min: box.min.toArray(),
    max: box.max.toArray(),
    center: c.toArray(),
    size: s.toArray(),
  }
}

/** The hit's outward normal in the upright (= world) frame. */
export function hitNormal(
  hit: THREE.Intersection,
  ray: THREE.Vector3
): V3 | null {
  if (!hit.face) return null
  const n = hit.face.normal
    .clone()
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
    .normalize()
  if (n.dot(ray) > 0) n.negate()
  return n.toArray()
}

/**
 * Drop a port onto the model's surface: a ray in from outside along
 * the port's normal. Kept where it is when nothing is hit nearby (a gap in
 * the model, or a point already on it).
 */
export function snapToSurface(u: Upright, port: ModelPort): ModelPort {
  const at = new THREE.Vector3(...denormalisePoint(port.p, u.min, u.max))
  const n = new THREE.Vector3(...port.n).normalize()
  // From outside the whole box, so the first hit is the visible surface.
  const reach = Math.hypot(...u.size)
  const origin = at
    .clone()
    .addScaledVector(n, reach)
    .sub(new THREE.Vector3(...u.center))
  const dir = n.clone().negate()
  u.object.updateMatrixWorld(true)
  const hits = new THREE.Raycaster(origin, dir, 0, reach * 2).intersectObject(
    u.object,
    true
  )
  const hit = hits.at(0)
  const normal = hit ? hitNormal(hit, dir) : null
  if (!hit || !normal) return port
  const point = hit.point.clone().add(new THREE.Vector3(...u.center))
  return {
    ...port,
    ...portFromHit({ point: point.toArray(), normal }, u.min, u.max),
  }
}
