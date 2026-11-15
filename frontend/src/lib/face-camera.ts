/**
 * An orthographic camera looking straight at one face of a box - a photo or
 * a rack elevation of a device's 3D model, where every port of a row looks
 * the same. Pure maths, no three.js: the model viewer frames its Front,
 * Rear and Top views with it, and offscreen face renders can reuse it.
 *
 * The box is the fitted model's upright size `size` [w, h, d] (m), standing
 * on the origin, centred on X and Z, front on −Z - the room's frame
 * (floorplan3d/world, lib/model-ports).
 */

export type V3 = [number, number, number]

export type Face = "front" | "rear" | "top" | "bottom" | "left" | "right"

export interface FaceCamera {
  /** Where the camera stands and what it looks at. */
  position: V3
  target: V3
  /** The camera's up: screen up. */
  up: V3
  /** The face's extent on screen (m), before the margin. */
  faceW: number
  faceH: number
  /** The view's half extents (m), margin included, matching `aspect`. */
  halfW: number
  halfH: number
  /** Clip planes that hold the whole box from `position`. */
  near: number
  far: number
}

/**
 * The camera for `face` of a box of size `size`, fitted to a viewport of
 * `aspect` (width / height) with `margin` of the face's larger side left
 * around it on each edge.
 *
 * Screen axes: front looks along +Z with up +Y (the model's left on the
 * right, as you stand before it); rear along −Z; top down −Y with the back
 * (+Z) up on screen; left and right along ±X.
 */
export function faceCamera(
  size: V3,
  face: Face,
  aspect = 1,
  margin = 0.06
): FaceCamera {
  const [w, h, d] = size.map((v) => Math.max(v, 1e-6)) as V3
  const target: V3 = [0, h / 2, 0]
  const radius = Math.hypot(w, h, d) / 2
  // Far enough that nothing of the box sits behind the camera.
  const dist = radius * 4
  let position: V3
  let up: V3 = [0, 1, 0]
  let faceW: number
  let faceH: number
  switch (face) {
    case "rear":
      position = [0, h / 2, dist]
      ;[faceW, faceH] = [w, h]
      break
    case "top":
      position = [0, h / 2 + dist, 0]
      up = [0, 0, 1]
      ;[faceW, faceH] = [w, d]
      break
    case "bottom":
      position = [0, h / 2 - dist, 0]
      up = [0, 0, -1]
      ;[faceW, faceH] = [w, d]
      break
    case "left":
      position = [-dist, h / 2, 0]
      ;[faceW, faceH] = [d, h]
      break
    case "right":
      position = [dist, h / 2, 0]
      ;[faceW, faceH] = [d, h]
      break
    default:
      position = [0, h / 2, -dist]
      ;[faceW, faceH] = [w, h]
  }
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  const pad = Math.max(faceW, faceH) * margin
  const needW = faceW + 2 * pad
  const needH = faceH + 2 * pad
  // Whichever side binds sets the scale; the other gets the slack.
  const halfH = Math.max(needH, needW / a) / 2
  return {
    position,
    target,
    up,
    faceW,
    faceH,
    halfW: halfH * a,
    halfH,
    near: Math.max(dist - radius * 1.5, radius / 100),
    far: dist + radius * 1.5,
  }
}

/**
 * The zoom for a three.js OrthographicCamera whose frustum is the viewport
 * in pixels (react-three-fiber's default): pixels per metre that show the
 * fitted view whole in a `width` × `height` px viewport.
 */
export function faceZoom(
  cam: Pick<FaceCamera, "halfW" | "halfH">,
  width: number,
  height: number
): number {
  if (width <= 0 || height <= 0) return 1
  return Math.min(width / (2 * cam.halfW), height / (2 * cam.halfH))
}
