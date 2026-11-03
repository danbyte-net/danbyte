import { useEffect, useLayoutEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import {
  isCameraSettling,
  markCameraMoving,
  prefersReducedMotion,
} from "./camera-motion"
import {
  MIN_DISTANCE_M,
  NAV_KEYS,
  PAGE_SCROLL_KEYS,
  advanceFly,
  dollyThroughStep,
  flyDuration,
  frameBox,
  nearForDistance,
  normalizeKey,
  orbitAround,
  panOffset,
  panPlaneNormal,
  panVector,
  pullInTarget,
  rayPlane,
  targetAtDepth,
  viewDirection,
  wheelNotches,
  zoomTowards,
} from "./camera-math"
import type { Fly, Vec3 } from "./camera-math"

export interface FlyToRequest {
  target: THREE.Vector3
  position: THREE.Vector3
}

/** What the scene asks of the camera from outside the canvas. */
export interface NavApi {
  /** Fly to frame the box from the camera's current heading, raised
   * `elevation` radians (a pleasant three-quarter view by default). */
  frame: (min: Vec3, max: Vec3, elevation?: number) => void
  /** Fly back to the whole plan (`bounds`), from the opening angle. */
  fitAll: () => void
}

/** Keyboard pan never drives the camera below (near) the slab. */
const CAMERA_MIN_Y = 0.1

/** The orbit target stays a hair above the floor so orbiting stays sane. */
const TARGET_MIN_Y = 0.05

/**
 * Cap on the per-frame dt fed to the pan and fly math: after a tab switch or
 * GC stall the frame delta can be seconds, and one uncapped step would
 * teleport the camera across the room.
 */
const MAX_NAV_DT = 0.1

/** Pixels a press may travel and still be a click, not a drag. */
const CLICK_SLOP_PX = 3

/** A wheel burst at one cursor spot keeps its anchor this long (ms) - one
 * raycast per burst, and the anchor stays put under the cursor. */
const WHEEL_BURST_MS = 300

/** Elevation a framed object is seen from (rad, ~35°). */
const FRAME_ELEVATION = 0.6

/** Keydown targets that own the keyboard - navigation must not steal keys. */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

const isEditableTarget = (t: EventTarget | null) =>
  t instanceof Element && t.closest(EDITABLE_SELECTOR) !== null

const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z]

// Scratch objects reused across frames and events (all synchronous).
const _fwd = new THREE.Vector3()
const _ndc = new THREE.Vector2()
const _normal = new THREE.Vector3()

/** What lies under a screen point: a surface of the room, the floor, or -
 * looking at the sky - a point at the orbit's depth on the ray. */
interface Anchor {
  point: [number, number, number]
  kind: "object" | "floor" | "free"
}

type Gesture =
  | {
      mode: "orbit"
      id: number
      x: number
      y: number
      pivot: Vec3
    }
  | {
      mode: "pan"
      id: number
      cam0: Vec3
      target0: Vec3
      grab: Vec3
      normal: Vec3
      reach: number
    }
  | {
      mode: "pinch"
      mid: [number, number]
      spread: number
      grab: Vec3
      normal: Vec3
      reach: number
    }

/**
 * The 3D views' navigation engine. No OrbitControls: their dolly scales
 * the distance to a fixed target, which on a site-sized plan sits far away,
 * so zooming in crawled and never reached what was under the cursor. Here
 * every gesture anchors on what the pointer is over:
 *
 * - **Wheel / pinch** zooms along the cursor ray toward the surface under
 *   it, each notch a share of the distance to THAT point (with a floor so
 *   the last metres never crawl), stopping short of the surface. The orbit
 *   target re-centres at that depth. At the stop, a further wheel-in on an
 *   object (not the floor) walks on through it, as before (`dollyThrough`).
 * - **Left-drag** orbits about the point under the cursor at press (Alt:
 *   about the current target). One finger on touch.
 * - **Right- or middle-drag**, or Shift/Ctrl+left, grab-pans: the point
 *   pressed stays under the cursor, so speed follows the distance to it.
 *   Two fingers pinch-zoom and pan together.
 * - **Keys** (`keyboard`): arrows / WASD glide level with the floor, Space
 *   / C rise and descend, Shift sprints, speed scaled by the distance to the
 *   target; 0 / Home fits the whole plan (`bounds`).
 * - **Fly-to**: push a request into `requestRef` (or call `navRef`) and the
 *   camera eases there; any input interrupts it, and a reduced-motion
 *   preference lands it at once.
 *
 * A drag never ends in a click - the object under the release is not
 * selected. Everything mutates the camera in place and asks the demand
 * frameloop for frames; nothing here renders React.
 */
export function CameraRig({
  target,
  maxDistance,
  requestRef,
  navRef,
  bounds,
  minDistance = MIN_DISTANCE_M,
  keyboard = true,
  dollyThrough = true,
}: {
  target: [number, number, number]
  maxDistance: number
  requestRef: React.MutableRefObject<FlyToRequest | null>
  /** Filled with the framing calls - see `NavApi`. */
  navRef?: React.MutableRefObject<NavApi | null>
  /** The whole plan, for Fit all (0 / Home). */
  bounds?: { min: Vec3; max: Vec3 }
  /** Closest the camera may come to the surface it zooms at (m). */
  minDistance?: number
  /** Arrows / WASD / Space / C move the camera (listeners on `window`). */
  keyboard?: boolean
  /** A wheel-in at `minDistance` walks the camera on through the object. */
  dollyThrough?: boolean
}) {
  const invalidate = useThree((s) => s.invalidate)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const targetRef = useRef(new THREE.Vector3(...target))
  // The opening view's direction (target → eye): what Fit all returns to.
  const homeDir = useRef<Vec3>([0.55, 0.6, 0.45])
  const fly = useRef<Fly | null>(null)
  const api = useRef<NavApi | null>(null)
  const pressed = useRef<Set<string>>(new Set())
  // Live props for the listeners, which are bound once.
  const opts = useRef({ maxDistance, minDistance, dollyThrough, bounds })
  opts.current = { maxDistance, minDistance, dollyThrough, bounds }

  const [tx, ty, tz] = target
  useLayoutEffect(() => {
    targetRef.current.set(tx, ty, tz)
    const d = camera.position.clone().sub(targetRef.current)
    if (d.lengthSq() > 0) homeDir.current = tuple(d.normalize())
    camera.lookAt(targetRef.current)
    camera.updateMatrixWorld()
    invalidate()
  }, [tx, ty, tz, camera, invalidate])

  useEffect(() => {
    const el = gl.domElement
    const raycaster = new THREE.Raycaster()
    const pointers = new Map<number, { x: number; y: number }>()
    let gesture: Gesture | null = null
    // Set when a press travelled: the click (and context menu) that ends
    // it is swallowed before the scene's own handlers see it.
    let dragged = false
    let downAt: { x: number; y: number } | null = null
    let wheelAnchor: (Anchor & { x: number; y: number; at: number }) | null =
      null

    const commit = () => {
      if (camera.position.y < CAMERA_MIN_Y) camera.position.y = CAMERA_MIN_Y
      if (targetRef.current.y < TARGET_MIN_Y) targetRef.current.y = TARGET_MIN_Y
      camera.lookAt(targetRef.current)
      camera.updateMatrixWorld()
      markCameraMoving()
      invalidate()
    }

    /** Any input takes the camera back from a fly-to. */
    const interrupt = () => {
      fly.current = null
      requestRef.current = null
    }

    const toNdc = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect()
      _ndc.set(
        ((clientX - r.left) / r.width) * 2 - 1,
        -((clientY - r.top) / r.height) * 2 + 1
      )
      return _ndc
    }

    const rayAt = (clientX: number, clientY: number) => {
      camera.updateMatrixWorld()
      raycaster.setFromCamera(toNdc(clientX, clientY), camera)
      return raycaster.ray
    }

    const forward = (): Vec3 => tuple(camera.getWorldDirection(_fwd))

    /** What the pointer is over. One raycast against the drawn meshes;
     * the floor plane if the ray hits nothing; else the orbit's depth. */
    const pick = (clientX: number, clientY: number): Anchor => {
      const ray = rayAt(clientX, clientY)
      const meshes: THREE.Object3D[] = []
      scene.traverseVisible((o) => {
        if (o instanceof THREE.Mesh) meshes.push(o)
      })
      for (const hit of raycaster.intersectObjects(meshes, false)) {
        const mat = (hit.object as THREE.Mesh).material
        const m = (Array.isArray(mat) ? mat[0] : mat) as
          THREE.Material | undefined
        if (m?.transparent && m.opacity < 0.05) continue
        let up = false
        if (hit.face) {
          _normal
            .copy(hit.face.normal)
            .transformDirection(hit.object.matrixWorld)
          up = _normal.y > 0.9
        }
        return { point: tuple(hit.point), kind: up ? "floor" : "object" }
      }
      const o = tuple(ray.origin)
      const dir = tuple(ray.direction)
      const t = rayPlane(o, dir, [0, 0, 0], [0, 1, 0])
      if (t != null && t < opts.current.maxDistance * 2)
        return {
          point: [o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t],
          kind: "floor",
        }
      const d = camera.position.distanceTo(targetRef.current)
      return {
        point: [o[0] + dir[0] * d, o[1] + dir[1] * d, o[2] + dir[2] * d],
        kind: "free",
      }
    }

    /** Re-centre the orbit target on the sight line at `anchor`'s depth. */
    const retarget = (anchor: Vec3) => {
      const t = targetAtDepth(
        tuple(camera.position),
        forward(),
        anchor,
        opts.current.minDistance
      )
      targetRef.current.set(t[0], t[1], t[2])
    }

    // ── Wheel ───────────────────────────────────────────────────────────
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      interrupt()
      const notches = wheelNotches(e.deltaY, e.deltaMode, e.ctrlKey)
      if (notches === 0) return
      const now = performance.now()
      let a = wheelAnchor
      if (
        !a ||
        now - a.at > WHEEL_BURST_MS ||
        Math.abs(e.clientX - a.x) > 2 ||
        Math.abs(e.clientY - a.y) > 2
      ) {
        a = { ...pick(e.clientX, e.clientY), x: e.clientX, y: e.clientY, at: 0 }
      }
      a.at = now
      wheelAnchor = a
      const { minDistance: gap, maxDistance: far } = opts.current
      const cam = tuple(camera.position)
      const d = camera.position.distanceTo(new THREE.Vector3(...a.point))
      if (
        notches < 0 &&
        opts.current.dollyThrough &&
        a.kind === "object" &&
        d <= gap * 1.2 + 1e-6
      ) {
        // Stopped at an object's face: walk on through it - the aisle
        // behind a rack - and anchor afresh on whatever lies beyond.
        const step = dollyThroughStep(cam, a.point, notches * 100, d, Infinity)
        if (step) {
          camera.position.add(new THREE.Vector3(...step))
          targetRef.current.add(new THREE.Vector3(...step))
        }
        wheelAnchor = null
        commit()
        return
      }
      const next = zoomTowards(cam, a.point, notches, {
        minGap: gap,
        maxDist: far,
      })
      camera.position.set(next[0], next[1], next[2])
      retarget(a.point)
      commit()
    }

    // ── Pointer gestures ────────────────────────────────────────────────
    const startOrbit = (id: number, x: number, y: number, alt: boolean) => {
      let pivot: Vec3 = tuple(targetRef.current)
      if (!alt) {
        const a = pick(x, y)
        if (a.kind !== "free") pivot = a.point
      }
      gesture = { mode: "orbit", id, x, y, pivot }
    }

    const startPan = (id: number, x: number, y: number) => {
      const a = pick(x, y)
      const cam = tuple(camera.position)
      const dist = camera.position.distanceTo(new THREE.Vector3(...a.point))
      gesture = {
        mode: "pan",
        id,
        cam0: cam,
        target0: tuple(targetRef.current),
        grab: a.point,
        normal: panPlaneNormal(forward()),
        reach: Math.max(dist * 4, 10),
      }
    }

    const pinchState = () => {
      const [p, q] = [...pointers.values()]
      return {
        mid: [(p.x + q.x) / 2, (p.y + q.y) / 2] as [number, number],
        spread: Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)),
      }
    }

    const startPinch = () => {
      const { mid, spread } = pinchState()
      const a = pick(mid[0], mid[1])
      const dist = camera.position.distanceTo(new THREE.Vector3(...a.point))
      gesture = {
        mode: "pinch",
        mid,
        spread,
        grab: a.point,
        normal: panPlaneNormal(forward()),
        reach: Math.max(dist * 4, 10),
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button > 2) return
      // Middle-drag pans here, not the browser's autoscroll.
      if (e.button === 1) e.preventDefault()
      interrupt()
      dragged = false
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // A synthetic or already-released pointer - nothing to capture.
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 1) downAt = { x: e.clientX, y: e.clientY }
      if (pointers.size === 2) {
        startPinch()
        return
      }
      if (pointers.size > 2) return
      const pan =
        e.button === 1 ||
        e.button === 2 ||
        (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey))
      if (pan) startPan(e.pointerId, e.clientX, e.clientY)
      else startOrbit(e.pointerId, e.clientX, e.clientY, e.altKey)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (
        downAt &&
        Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > CLICK_SLOP_PX
      )
        dragged = true
      const g = gesture
      if (!g) return
      if (g.mode === "pinch") {
        if (pointers.size < 2) return
        const { mid, spread } = pinchState()
        // Pan: keep the grabbed point under the fingers' midpoint.
        const ray = rayAt(mid[0], mid[1])
        const off = panOffset(
          tuple(camera.position),
          tuple(ray.direction),
          g.grab,
          g.normal,
          g.reach
        )
        if (off) {
          camera.position.add(new THREE.Vector3(...off))
          targetRef.current.add(new THREE.Vector3(...off))
        }
        // Zoom: scale the distance to the grabbed point by the spread.
        const grab = new THREE.Vector3(...g.grab)
        const offset = camera.position.clone().sub(grab)
        const d = offset.length()
        const next = Math.min(
          opts.current.maxDistance,
          Math.max(opts.current.minDistance, (d * g.spread) / spread)
        )
        if (d > 0) camera.position.copy(grab).addScaledVector(offset, next / d)
        retarget(g.grab)
        g.mid = mid
        g.spread = spread
        commit()
        return
      }
      if (g.id !== e.pointerId) return
      if (g.mode === "orbit") {
        const h = Math.max(1, el.clientHeight)
        const yaw = (-2 * Math.PI * (e.clientX - g.x)) / h
        const pitch = (-2 * Math.PI * (e.clientY - g.y)) / h
        g.x = e.clientX
        g.y = e.clientY
        const cam = tuple(camera.position)
        const tgt = tuple(targetRef.current)
        let r = orbitAround(cam, tgt, g.pivot, yaw, pitch)
        // Never under the slab: drop the tilt that would take it there.
        if (r.cam[1] < CAMERA_MIN_Y) r = orbitAround(cam, tgt, g.pivot, yaw, 0)
        camera.position.set(...r.cam)
        targetRef.current.set(...r.target)
        commit()
        return
      }
      const ray = rayAt(e.clientX, e.clientY)
      const off = panOffset(
        g.cam0,
        tuple(ray.direction),
        g.grab,
        g.normal,
        g.reach
      )
      if (!off) return
      camera.position.set(
        g.cam0[0] + off[0],
        g.cam0[1] + off[1],
        g.cam0[2] + off[2]
      )
      targetRef.current.set(
        g.target0[0] + off[0],
        g.target0[1] + off[1],
        g.target0[2] + off[2]
      )
      commit()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Already released.
      }
      if (pointers.size === 0) {
        gesture = null
        downAt = null
        return
      }
      // A finger lifted off a pinch: the other carries on orbiting from
      // where it is, without a jump.
      if (pointers.size === 1) {
        const [[id, p]] = [...pointers.entries()]
        startOrbit(id, p.x, p.y, false)
      }
    }

    // Capture phase on the canvas: the scene's click handlers listen on
    // the canvas's parent, so a swallowed click never reaches them.
    const onClickCapture = (e: MouseEvent) => {
      if (dragged) {
        e.stopPropagation()
        dragged = false
      }
    }
    const onContextMenu = (e: MouseEvent) => {
      // The canvas has no browser menu - right-drag is pan.
      e.preventDefault()
      if (dragged) e.stopPropagation()
    }

    el.style.touchAction = "none"
    el.addEventListener("wheel", onWheel, { passive: false })
    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener("pointermove", onPointerMove)
    el.addEventListener("pointerup", onPointerUp)
    el.addEventListener("pointercancel", onPointerUp)
    el.addEventListener("click", onClickCapture, true)
    el.addEventListener("contextmenu", onContextMenu, true)
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener("pointermove", onPointerMove)
      el.removeEventListener("pointerup", onPointerUp)
      el.removeEventListener("pointercancel", onPointerUp)
      el.removeEventListener("click", onClickCapture, true)
      el.removeEventListener("contextmenu", onContextMenu, true)
    }
  }, [gl, camera, scene, invalidate, requestRef])

  // The framing calls, for keys and HUD buttons outside the canvas.
  useEffect(() => {
    const request = (to: { target: Vec3; position: Vec3 }) => {
      requestRef.current = {
        target: new THREE.Vector3(...to.target),
        position: new THREE.Vector3(...to.position),
      }
      invalidate()
    }
    const calls: NavApi = {
      frame(min, max, elevation = FRAME_ELEVATION) {
        const dir = viewDirection(
          tuple(camera.getWorldDirection(_fwd)),
          elevation
        )
        request(
          frameBox(min, max, dir, (camera.fov * Math.PI) / 180, camera.aspect, {
            minDist: opts.current.minDistance * 4,
          })
        )
      },
      fitAll() {
        const b = opts.current.bounds
        if (!b) return
        request(
          frameBox(
            b.min,
            b.max,
            homeDir.current,
            (camera.fov * Math.PI) / 180,
            camera.aspect,
            { margin: 1.05 }
          )
        )
      },
    }
    api.current = calls
    if (navRef) navRef.current = calls
    return () => {
      api.current = null
      if (navRef) navRef.current = null
    }
  }, [navRef, camera, invalidate, requestRef])

  useEffect(() => {
    if (!keyboard) return
    const onKeyDown = (e: KeyboardEvent) => {
      // Leave browser/app shortcuts (Alt+Left history, Ctrl+A…) alone.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(e.target)) return
      if (e.key === "0" || e.key === "Home") {
        if (!opts.current.bounds) return
        e.preventDefault()
        api.current?.fitAll()
        return
      }
      const key = normalizeKey(e.key)
      if (!NAV_KEYS.has(key)) return
      // Only keys whose default scrolls the page; w/a/s/d/c/Shift stay
      // untouched (and Escape is never ours - the scene's flows own it).
      if (PAGE_SCROLL_KEYS.has(key)) e.preventDefault()
      // First nav key of a session: pull the orbit target to ~3 m ahead so
      // the walk speed and an Alt-drag fit the near view. Idempotent
      // afterwards - key pans move camera and target together.
      if (pressed.current.size === 0) {
        const pulled = pullInTarget(
          tuple(camera.position),
          tuple(targetRef.current)
        )
        if (pulled) targetRef.current.set(pulled[0], pulled[1], pulled[2])
      }
      pressed.current.add(key)
      // Driving the camera overrides an in-flight (or just-requested) fly-to.
      fly.current = null
      requestRef.current = null
      // frameloop="demand": kick the loop; useFrame keeps it alive from here.
      invalidate()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      // No guards on release: a key that went down must always come back up,
      // even if focus moved into a field or a modifier joined mid-hold.
      pressed.current.delete(normalizeKey(e.key))
    }
    const onBlur = () => {
      // Alt-tab with a key held must not pan forever.
      pressed.current.clear()
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [keyboard, invalidate, requestRef, camera])

  useFrame((state, delta) => {
    const cam = state.camera as THREE.PerspectiveCamera
    const tgt = targetRef.current
    // Settle loop: racks defer their LOD/panel swaps while the camera moves
    // (see camera-motion.ts), and with frameloop="demand" nothing else
    // promises a frame AFTER the motion window closes. Keep frames coming
    // through the window plus its tail, so the swap-applying frame always
    // arrives, whatever moved the camera.
    if (isCameraSettling()) invalidate()
    // Dynamic near-plane: 1 cm nose-on, 0.5 m across the hall - a fixed near
    // small enough for faceplates would shimmer the 3 mm floor overlays from
    // a distance (depth precision). Re-fit only past 20% drift so the
    // projection isn't rebuilt every frame; runs only on frames something
    // else already rendered, so it adds no invalidation source of its own.
    const near = nearForDistance(cam.position.distanceTo(tgt), cam.position.y)
    if (Math.abs(near - cam.near) / cam.near > 0.2) {
      cam.near = near
      cam.updateProjectionMatrix()
    }
    // Pick up a new request.
    if (requestRef.current) {
      const to = requestRef.current
      requestRef.current = null
      const travel = Math.max(
        cam.position.distanceTo(to.position),
        tgt.distanceTo(to.target)
      )
      fly.current = {
        fromPos: tuple(cam.position),
        fromTarget: tuple(tgt),
        toPos: tuple(to.position),
        toTarget: tuple(to.target),
        duration: prefersReducedMotion() ? 0 : flyDuration(travel),
        t: 0,
      }
    }
    const f = fly.current
    if (f) {
      const step = advanceFly(f, Math.min(delta, MAX_NAV_DT))
      f.t = step.t
      cam.position.set(...step.pos)
      tgt.set(...step.target)
      cam.lookAt(tgt)
      markCameraMoving()
      if (step.done) fly.current = null
      invalidate()
      // A fly-to owns the frame while it runs (a nav keydown cancels it).
      return
    }
    const keysDown = pressed.current
    if (keysDown.size === 0) return
    // Forward = camera→target projected onto the ground plane.
    _fwd.copy(tgt).sub(cam.position)
    _fwd.y = 0
    if (_fwd.lengthSq() < 1e-8) {
      // Looking straight down: fall back to screen-up so arrows keep meaning.
      _fwd.set(0, 1, 0).applyQuaternion(cam.quaternion)
      _fwd.y = 0
    }
    if (_fwd.lengthSq() > 1e-8) _fwd.normalize()
    const [dx, dy, dz] = panVector(
      keysDown,
      [_fwd.x, _fwd.z],
      cam.position.distanceTo(tgt),
      Math.min(delta, MAX_NAV_DT)
    )
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      cam.position.x += dx
      cam.position.y += dy
      cam.position.z += dz
      tgt.x += dx
      tgt.y += dy
      tgt.z += dz
      if (cam.position.y < CAMERA_MIN_Y) cam.position.y = CAMERA_MIN_Y
      if (tgt.y < TARGET_MIN_Y) tgt.y = TARGET_MIN_Y
      cam.lookAt(tgt)
      markCameraMoving()
    }
    // Demand frameloop: keep frames coming while any nav key is held -
    // opposing keys can sum to zero, but a release must resume motion
    // without needing a fresh keydown.
    invalidate()
  })

  return null
}
