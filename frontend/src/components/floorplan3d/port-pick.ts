import { useEffect } from "react"
import { useThree } from "@react-three/fiber"
import type { RootState } from "@react-three/fiber"
import * as THREE from "three"

/**
 * Which hit takes the pointer when a port marker shares the ray with the
 * body it sits on. A marker stands a hair over its opening, and the
 * opening sits a little inside the model's box: the room's invisible
 * device box and the viewer's module bay boxes are nearer to the camera
 * than the ports on them. r3f hands events out nearest first, and a body
 * that stopped an event once keeps stopping every later one while it stays
 * hovered - so a port behind a body's face never saw the pointer.
 *
 * `portFirst` reorders a canvas's hits (r3f's `events.filter`): a marker
 * hit that faces the ray and lies within `PORT_PICK_SLACK_M` of the
 * nearest hit goes first, so the port wins hover, click and right-click
 * over the body it sits on. A marker facing away - a rear port seen
 * through the device - is no pick at all. `PortPickPrecedence` installs it
 * on a canvas.
 */

/** How far behind the nearest hit (m, along the ray) a port still counts
 * as on that surface: an opening's depth into the box, at a slant. */
export const PORT_PICK_SLACK_M = 0.015

/** The userData flag of a port markers' hit mesh. */
export const PORT_MARKERS_KEY = "portMarkers"

const _m = new THREE.Matrix4()
const _n = new THREE.Vector3()

export function isPortMarkerHit(hit: THREE.Intersection): boolean {
  return !!hit.object.userData[PORT_MARKERS_KEY]
}

/** Whether a marker hit's quad faces back along `dir` (the ray's way). The
 * quad's +Z is the port's outward normal. */
export function facesRay(hit: THREE.Intersection, dir: THREE.Vector3): boolean {
  const obj = hit.object
  _n.set(0, 0, 1)
  if (obj instanceof THREE.InstancedMesh && hit.instanceId != null) {
    obj.getMatrixAt(hit.instanceId, _m)
    _n.transformDirection(_m)
  }
  _n.transformDirection(obj.matrixWorld)
  return _n.dot(dir) < 0
}

export function portFirst<T extends THREE.Intersection>(
  hits: readonly T[],
  dir: THREE.Vector3,
  slack = PORT_PICK_SLACK_M
): T[] {
  const kept = hits.filter((h) => !isPortMarkerHit(h) || facesRay(h, dir))
  const i = kept.findIndex(isPortMarkerHit)
  if (i <= 0) return kept
  if (kept[i].distance - kept[0].distance > slack) return kept
  return [kept[i], ...kept.slice(0, i), ...kept.slice(i + 1)]
}

type HitFilter = NonNullable<RootState["events"]["filter"]>

/** Puts `portFirst` on the canvas it is mounted in. */
export function PortPickPrecedence() {
  const setEvents = useThree((s) => s.setEvents)
  const get = useThree((s) => s.get)
  useEffect(() => {
    const prev = get().events.filter
    const filter: HitFilter = (hits, state) =>
      portFirst(prev ? prev(hits, state) : hits, state.raycaster.ray.direction)
    setEvents({ filter })
    return () => setEvents({ filter: prev })
  }, [get, setEvents])
  return null
}
