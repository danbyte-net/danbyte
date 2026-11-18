import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { readCameraMode } from "@/lib/camera-mode"

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
  normalizeKey,
  panVector,
  pullInTarget,
  rayPlane,
  targetAtDepth,
  viewDirection,
  wheelNotches,
  zoomTowards,
} from "./camera-math"
import type { Fly, Vec3 } from "./camera-math"
import {
  FLOOR_MAX_POLAR,
  MARKER_FADE_IN,
  MODEL_MAX_POLAR,
  adaptiveFar,
  adaptiveNear,
  classifyWheel,
  clickPivot,
  easeShare,
  inView,
  markerOpacity,
  orbitLimited,
  orthoZoomAt,
  orthoZoomFactor,
  screenPan,
  worldPerPixel,
} from "./camera-nav"
import type { WheelGesture } from "./camera-nav"

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

/**
 * The rig as r3f's `controls` (what `useThree((s) => s.controls)` reads):
 * the OrbitControls-shaped part the viewers use - `target`, `update()`
 * after placing the camera, `enabled` to hold the camera still while a
 * port is dragged - and `flyTo` for an eased re-frame.
 */
export interface RigControls {
  target: THREE.Vector3
  enabled: boolean
  update: () => void
  flyTo: (position: THREE.Vector3, target: THREE.Vector3) => void
}

/** Keyboard pan and orbits never drive the camera below (near) the slab. */
const CAMERA_MIN_Y = 0.1

/** The orbit target stays a hair above the floor so orbiting stays sane. */
const TARGET_MIN_Y = 0.05

/**
 * Cap on the per-frame dt fed to the pan, ease and fly math: after a tab
 * switch or GC stall the frame delta can be seconds, and one uncapped step
 * would teleport the camera across the room.
 */
const MAX_NAV_DT = 0.1

/** Pixels a press may travel and still be a click, not a drag. */
const CLICK_SLOP_PX = 3

/** A wheel burst at one cursor spot keeps its anchor (and a trackpad
 * swipe stays a pan) this long (ms). */
const WHEEL_BURST_MS = 300

/** Elevation a framed object is seen from (rad, ~35°). */
const FRAME_ELEVATION = 0.6

/** A dolly-through step is this many stop gaps (0.35 m at the room's 5 cm). */
const THROUGH_STEPS_PER_GAP = 7

/** How often (ms) the nearest surface in view is re-measured - what keeps
 * the near plane in front of it. */
const PROBE_MS = 200

/** The pivot marker's radius, as a share of the view's height at its depth. */
const MARKER_SHARE = 0.008

/** Keydown targets that own the keyboard - navigation must not steal keys. */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

const isEditableTarget = (t: EventTarget | null) =>
  t instanceof Element && t.closest(EDITABLE_SELECTOR) !== null

const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z]

const isOrtho = (c: THREE.Camera): c is THREE.OrthographicCamera =>
  (c as THREE.OrthographicCamera).isOrthographicCamera === true

// Scratch objects reused across frames and events (all synchronous).
const _fwd = new THREE.Vector3()
const _ndc = new THREE.Vector2()
const _normal = new THREE.Vector3()
const _v = new THREE.Vector3()
const _probeBox = new THREE.Box3()
const WORLD_UP = new THREE.Vector3(0, 1, 0)

/** What lies under a screen point: a surface of the scene, the floor, or -
 * looking at the sky - a point at the orbit's depth on the ray. */
interface Anchor {
  point: [number, number, number]
  kind: "object" | "floor" | "free"
}

/** Where the camera is easing to: the eye, the orbit target, the zoom. */
interface Pose {
  pos: THREE.Vector3
  target: THREE.Vector3
  zoom: number
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
      x0: number
      y0: number
      pos0: THREE.Vector3
      target0: THREE.Vector3
      perPx: number
      right: Vec3
      up: Vec3
    }
  | {
      mode: "pinch"
      mid: [number, number]
      spread: number
      perPx: number
      grab: THREE.Vector3
    }

/** The sight line and screen axes of a pose (no roll: up stays up). */
function axesOf(pos: THREE.Vector3, target: THREE.Vector3) {
  const fwd = new THREE.Vector3().subVectors(target, pos)
  if (fwd.lengthSq() < 1e-18) fwd.set(0, 0, -1)
  fwd.normalize()
  const right = new THREE.Vector3().crossVectors(fwd, WORLD_UP)
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0)
  right.normalize()
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize()
  return { fwd, right, up }
}

/**
 * The 3D views' one camera: the room, a building's levels, the rack and
 * cabinet views, the device model viewer and stack view, the ports editor
 * and the model preview. No OrbitControls: their dolly scales the distance
 * to a fixed target and their pan ignores what is under the cursor.
 *
 * - **Click** (no drag) on a surface makes that point the pivot. Nothing
 *   moves: the orbit target slides along the sight line to its depth, and
 *   a small marker fades in on it. The click still selects as before.
 * - **Left-drag** orbits about the pivot - the clicked point while it is on
 *   screen, else the view's centre (Alt: the point under the cursor). The
 *   horizon stays level; on a floor the camera stays above the pivot's
 *   horizon, a lone model may be seen from below. One finger on touch.
 * - **Right- or middle-drag**, Shift / Ctrl + left, or any left-drag in
 *   Pan mode (lib/camera-mode): slides the view in the screen plane, no
 *   turn; the point pressed stays under the cursor.
 * - **Wheel / pinch** zooms toward the point under the cursor, each notch a
 *   share of the distance to it, stopping just short of the surface; a
 *   further wheel-in walks camera and target on through (`dollyThrough`),
 *   so zoom never sticks. No distance limits. A trackpad's two-finger
 *   swipe pans, its pinch zooms. An orthographic camera zooms about the
 *   cursor.
 * - **Keys** (`keyboard`): arrows / WASD glide level with the floor, Space
 *   / C rise and descend, Shift sprints; 0 / Home fits the whole plan.
 * - **Fly-to**: push a request into `requestRef` (or call `navRef`, or the
 *   controls' `flyTo`) and the camera eases there in about 0.3 s.
 *
 * Drags and zooms ease toward where the hand put them; under reduced
 * motion everything lands at once. A drag never ends in a click - the
 * object under the release is not selected. The near and far planes follow
 * the camera (see `adaptiveNear`). Everything mutates the camera in place
 * and asks the demand frameloop for frames; nothing here renders React.
 */
export function CameraRig({
  target,
  maxDistance = Infinity,
  requestRef: givenRequestRef,
  navRef,
  bounds,
  minDistance = MIN_DISTANCE_M,
  keyboard = true,
  dollyThrough = true,
  floor = true,
  minNear = 0.05,
}: {
  target: [number, number, number]
  /** How far off the floor plane still counts as under the cursor (m) -
   * the plan's reach. Not a zoom limit: zoom has none. */
  maxDistance?: number
  requestRef?: React.MutableRefObject<FlyToRequest | null>
  /** Filled with the framing calls - see `NavApi`. */
  navRef?: React.MutableRefObject<NavApi | null>
  /** The whole plan, for Fit all (0 / Home) - or a reader, for bounds that
   * move without a render (the building's explode). */
  bounds?: { min: Vec3; max: Vec3 } | (() => { min: Vec3; max: Vec3 } | null)
  /** How short of the surface under the cursor a zoom stops (m). */
  minDistance?: number
  /** Arrows / WASD / Space / C move the camera (listeners on `window`). */
  keyboard?: boolean
  /** A wheel-in at the stop walks the camera on through the object. */
  dollyThrough?: boolean
  /** A scene on a floor at y = 0 (the room, racks, cabinets): the camera
   * stays above it. False for a lone model, which may be seen from below. */
  floor?: boolean
  /** The least the near plane may be (m). */
  minNear?: number
}) {
  const invalidate = useThree((s) => s.invalidate)
  const camera = useThree((s) => s.camera) as
    THREE.PerspectiveCamera | THREE.OrthographicCamera
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const set = useThree((s) => s.set)
  const get = useThree((s) => s.get)
  const ownRequestRef = useRef<FlyToRequest | null>(null)
  const requestRef = givenRequestRef ?? ownRequestRef
  const targetRef = useRef(new THREE.Vector3(...target))
  // The opening view's direction (target → eye): what Fit all returns to.
  const homeDir = useRef<Vec3>([0.55, 0.6, 0.45])
  const fly = useRef<Fly | null>(null)
  const api = useRef<NavApi | null>(null)
  const pressed = useRef<Set<string>>(new Set())
  // The clicked pivot (null: orbit about the target).
  const pivotRef = useRef<THREE.Vector3 | null>(null)
  // Where an eased gesture is taking the camera (null: settled).
  const goalRef = useRef<Pose | null>(null)
  // The pivot marker: when it was set (s), and whether an orbit holds it.
  const markerRef = useRef<{ at: number; held: boolean } | null>(null)
  // The nearest surface in view, as last measured: depth and where from.
  const probeRef = useRef<{
    depth: number
    from: THREE.Vector3
    at: number
  } | null>(null)
  // The far plane the scene asked for, and the one the rig last set.
  const farRef = useRef<{ base: number; set: number } | null>(null)
  // Live props for the listeners, which are bound once.
  const opts = useRef({
    maxDistance,
    minDistance,
    dollyThrough,
    bounds,
    floor,
    minNear,
  })
  opts.current = {
    maxDistance,
    minDistance,
    dollyThrough,
    bounds,
    floor,
    minNear,
  }

  const marker = useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({
        color: "#0ea5e9",
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
    )
    m.visible = false
    m.renderOrder = 10_000
    m.frustumCulled = false
    // Never under the cursor: not for picking, not for the scene's events.
    m.raycast = () => {}
    m.userData.cameraPivotMarker = true
    return m
  }, [])
  useEffect(
    () => () => {
      marker.geometry.dispose()
      ;(marker.material as THREE.Material).dispose()
    },
    [marker]
  )

  const [tx, ty, tz] = target
  useLayoutEffect(() => {
    targetRef.current.set(tx, ty, tz)
    const d = camera.position.clone().sub(targetRef.current)
    if (d.lengthSq() > 0) homeDir.current = tuple(d.normalize())
    camera.lookAt(targetRef.current)
    camera.updateMatrixWorld()
    goalRef.current = null
    pivotRef.current = null
    invalidate()
  }, [tx, ty, tz, camera, invalidate])

  // The rig as r3f's controls, for the viewers (see `RigControls`).
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const controls = useMemo(
    (): RigControls => ({
      target: targetRef.current,
      enabled: true,
      update() {
        const cam = cameraRef.current
        cam.lookAt(targetRef.current)
        cam.updateMatrixWorld()
        goalRef.current = null
        pivotRef.current = null
        fly.current = null
        farRef.current = null
        probeRef.current = null
        invalidate()
      },
      flyTo(position, to) {
        goalRef.current = null
        pivotRef.current = null
        requestRef.current = { position: position.clone(), target: to.clone() }
        invalidate()
      },
    }),
    [invalidate, requestRef]
  )
  useEffect(() => {
    set({ controls: controls as unknown as THREE.EventDispatcher })
    return () => {
      if ((get().controls as unknown) === controls) set({ controls: null })
    }
  }, [set, get, controls])

  useEffect(() => {
    const el = gl.domElement
    const raycaster = new THREE.Raycaster()
    const pointers = new Map<number, { x: number; y: number }>()
    let gesture: Gesture | null = null
    // Set when a press travelled: the click (and context menu) that ends
    // it is swallowed before the scene's own handlers see it.
    let dragged = false
    let downAt: { x: number; y: number; button: number } | null = null
    let wheelAnchor: (Anchor & { x: number; y: number; at: number }) | null =
      null
    let wheelKind: { kind: WheelGesture; at: number } | null = null

    /** The pose gestures build on: where the camera is going, else where
     * it is. */
    const base = (): Pose =>
      goalRef.current ?? {
        pos: camera.position.clone(),
        target: targetRef.current.clone(),
        zoom: camera.zoom,
      }

    const clampFloor = (p: { pos: THREE.Vector3; target: THREE.Vector3 }) => {
      if (!opts.current.floor) return
      if (p.pos.y < CAMERA_MIN_Y) p.pos.y = CAMERA_MIN_Y
      if (p.target.y < TARGET_MIN_Y) p.target.y = TARGET_MIN_Y
    }

    /** Ease toward `p` (applied in the frame loop). */
    const goTo = (p: Pose) => {
      clampFloor(p)
      goalRef.current = p
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
        if (hit.face && opts.current.floor) {
          _normal
            .copy(hit.face.normal)
            .transformDirection(hit.object.matrixWorld)
          up = _normal.y > 0.9
        }
        return { point: tuple(hit.point), kind: up ? "floor" : "object" }
      }
      const o = tuple(ray.origin)
      const dir = tuple(ray.direction)
      if (opts.current.floor) {
        const t = rayPlane(o, dir, [0, 0, 0], [0, 1, 0])
        if (t != null && t < opts.current.maxDistance * 2)
          return {
            point: [o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t],
            kind: "floor",
          }
      }
      // Nothing there: the orbit's depth on the ray.
      const d = Math.max(
        opts.current.minDistance,
        _v.subVectors(targetRef.current, ray.origin).dot(ray.direction)
      )
      return {
        point: [o[0] + dir[0] * d, o[1] + dir[1] * d, o[2] + dir[2] * d],
        kind: "free",
      }
    }

    /** World units per screen pixel at `depth` along the sight line. */
    const perPixel = (depth: number, zoom: number) => {
      const h = el.clientHeight
      if (isOrtho(camera))
        return worldPerPixel(
          {
            kind: "orthographic",
            viewHeight: camera.top - camera.bottom,
            zoom,
          },
          h
        )
      return worldPerPixel(
        { kind: "perspective", fovY: (camera.fov * Math.PI) / 180, depth },
        h
      )
    }

    /** Depth of `point` along the pose's sight line, at least the stop -
     * and no more than a few times the target's, so a grab near the
     * horizon does not fling the view. */
    const depthOf = (p: Pose, point: THREE.Vector3) => {
      const { fwd } = axesOf(p.pos, p.target)
      const reach = Math.max(p.pos.distanceTo(p.target) * 4, 10)
      return Math.min(
        reach,
        Math.max(opts.current.minDistance, _v.subVectors(point, p.pos).dot(fwd))
      )
    }

    /** Whether the clicked pivot is still on screen. */
    const pivotShown = () => {
      const p = pivotRef.current
      if (!p) return false
      camera.updateMatrixWorld()
      const v = p.clone().project(camera)
      return inView([v.x, v.y, v.z])
    }

    /** A click at a surface: pivot there, nothing moves. */
    const setPivotAt = (clientX: number, clientY: number) => {
      const a = pick(clientX, clientY)
      if (a.kind === "free") return
      const p = base()
      const { fwd } = axesOf(p.pos, p.target)
      const r = clickPivot(
        tuple(p.pos),
        tuple(fwd),
        a.point,
        opts.current.minDistance
      )
      pivotRef.current = new THREE.Vector3(...r.pivot)
      if (goalRef.current) goalRef.current.target.set(...r.target)
      else targetRef.current.set(...r.target)
      markerRef.current = { at: performance.now() / 1000, held: false }
      invalidate()
    }

    // ── Wheel ───────────────────────────────────────────────────────────
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      interrupt()
      const now = performance.now()
      const latched =
        wheelKind && now - wheelKind.at < WHEEL_BURST_MS ? wheelKind.kind : null
      const kind = classifyWheel(e, latched)
      wheelKind = { kind, at: now }

      if (kind === "pan") {
        // A trackpad swipe: slide the view like scrolling a page.
        const p = base()
        const px = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1
        const { right, up } = axesOf(p.pos, p.target)
        const off = new THREE.Vector3(
          ...screenPan(
            -e.deltaX * px,
            -e.deltaY * px,
            perPixel(depthOf(p, pivotRef.current ?? p.target), p.zoom),
            tuple(right),
            tuple(up)
          )
        )
        p.pos.add(off)
        p.target.add(off)
        goTo(p)
        return
      }

      const notches = wheelNotches(e.deltaY, e.deltaMode, e.ctrlKey)
      if (notches === 0) return

      if (isOrtho(camera)) {
        const p = base()
        const { right, up } = axesOf(p.pos, p.target)
        const ndc = toNdc(e.clientX, e.clientY)
        const r = orthoZoomAt(
          [ndc.x, ndc.y],
          (camera.right - camera.left) / 2,
          (camera.top - camera.bottom) / 2,
          p.zoom,
          orthoZoomFactor(notches),
          tuple(right),
          tuple(up)
        )
        const shift = new THREE.Vector3(...r.shift)
        p.pos.add(shift)
        p.target.add(shift)
        p.zoom = r.zoom
        goTo(p)
        return
      }

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
      const gap = opts.current.minDistance
      const p = base()
      const d = p.pos.distanceTo(_v.set(...a.point))
      if (
        notches < 0 &&
        opts.current.dollyThrough &&
        a.kind !== "floor" &&
        d <= gap * 1.2 + 1e-6
      ) {
        // Stopped at a face: walk on through it - the aisle behind a rack,
        // the inside of a chassis - and anchor afresh beyond. The floor is
        // never passed through.
        const step = dollyThroughStep(
          tuple(p.pos),
          a.point,
          notches * 100,
          d,
          Infinity,
          gap * THROUGH_STEPS_PER_GAP
        )
        if (step) {
          const s = new THREE.Vector3(...step)
          p.pos.add(s)
          p.target.add(s)
        }
        wheelAnchor = null
        pivotRef.current = null
        goTo(p)
        return
      }
      const { fwd } = axesOf(p.pos, p.target)
      const next = zoomTowards(tuple(p.pos), a.point, notches, {
        minGap: gap,
        maxDist: Infinity,
      })
      p.pos.set(...next)
      p.target.set(...targetAtDepth(next, tuple(fwd), a.point, gap))
      goTo(p)
    }

    // ── Pointer gestures ────────────────────────────────────────────────
    const startOrbit = (id: number, x: number, y: number, alt: boolean) => {
      let pivot: Vec3 = tuple(base().target)
      if (alt) {
        const a = pick(x, y)
        if (a.kind !== "free") pivot = a.point
      } else if (pivotShown()) {
        pivot = tuple(pivotRef.current!)
      }
      gesture = { mode: "orbit", id, x, y, pivot }
    }

    const startPan = (id: number, x: number, y: number) => {
      const p = base()
      const a = pick(x, y)
      const { right, up } = axesOf(p.pos, p.target)
      gesture = {
        mode: "pan",
        id,
        x0: x,
        y0: y,
        pos0: p.pos.clone(),
        target0: p.target.clone(),
        perPx: perPixel(depthOf(p, _v.set(...a.point)), p.zoom),
        right: tuple(right),
        up: tuple(up),
      }
    }

    const startDrag = (
      id: number,
      x: number,
      y: number,
      pan: boolean,
      alt: boolean
    ) => {
      // Pan mode locks rotation: every drag pans.
      if (pan || readCameraMode() === "pan") startPan(id, x, y)
      else startOrbit(id, x, y, alt)
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
      // Fingers own the camera directly: drop any easing first.
      if (goalRef.current) {
        camera.position.copy(goalRef.current.pos)
        targetRef.current.copy(goalRef.current.target)
        goalRef.current = null
      }
      const a = pick(mid[0], mid[1])
      const p = base()
      const grab = new THREE.Vector3(...a.point)
      gesture = {
        mode: "pinch",
        mid,
        spread,
        perPx: perPixel(depthOf(p, grab), p.zoom),
        grab,
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
      if (pointers.size === 1)
        downAt = { x: e.clientX, y: e.clientY, button: e.button }
      if (pointers.size === 2) {
        startPinch()
        return
      }
      if (pointers.size > 2) return
      const pan =
        e.button === 1 ||
        e.button === 2 ||
        (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey))
      startDrag(e.pointerId, e.clientX, e.clientY, pan, e.altKey)
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
      // Something in the scene took the drag (a port being moved).
      if (!controls.enabled) {
        gesture = null
        if (markerRef.current?.held) markerRef.current = null
        return
      }
      if (g.mode === "pinch") {
        if (pointers.size < 2) return
        const { mid, spread } = pinchState()
        // Pan: the fingers' midpoint carries the view with it.
        const { right, up } = axesOf(camera.position, targetRef.current)
        const off = new THREE.Vector3(
          ...screenPan(
            mid[0] - g.mid[0],
            mid[1] - g.mid[1],
            g.perPx,
            tuple(right),
            tuple(up)
          )
        )
        camera.position.add(off)
        targetRef.current.add(off)
        g.grab.add(off)
        if (isOrtho(camera)) {
          camera.zoom = Math.max(1e-9, (camera.zoom * spread) / g.spread)
          camera.updateProjectionMatrix()
          g.perPx *= g.spread / spread
        } else {
          // Zoom: scale the distance to the grabbed point by the spread,
          // never through it.
          const offset = camera.position.clone().sub(g.grab)
          const d = offset.length()
          const next = Math.max(
            opts.current.minDistance,
            (d * g.spread) / spread
          )
          if (d > 0) {
            camera.position.copy(g.grab).addScaledVector(offset, next / d)
            g.perPx *= next / d
          }
        }
        g.mid = mid
        g.spread = spread
        clampFloor({ pos: camera.position, target: targetRef.current })
        camera.lookAt(targetRef.current)
        camera.updateMatrixWorld()
        markCameraMoving()
        invalidate()
        return
      }
      if (g.id !== e.pointerId) return
      if (g.mode === "orbit") {
        const h = Math.max(1, el.clientHeight)
        const yaw = (-2 * Math.PI * (e.clientX - g.x)) / h
        const pitch = (-2 * Math.PI * (e.clientY - g.y)) / h
        g.x = e.clientX
        g.y = e.clientY
        const p = base()
        const r = orbitLimited(
          tuple(p.pos),
          tuple(p.target),
          g.pivot,
          yaw,
          pitch,
          opts.current.floor
            ? { maxPolar: FLOOR_MAX_POLAR, minY: CAMERA_MIN_Y }
            : { maxPolar: MODEL_MAX_POLAR }
        )
        p.pos.set(...r.cam)
        p.target.set(...r.target)
        if (dragged) {
          // Show what it turns about while it turns.
          const pv = pivotRef.current
          if (!pv || pv.distanceToSquared(_v.set(...g.pivot)) > 0)
            pivotRef.current = new THREE.Vector3(...g.pivot)
          markerRef.current = { at: 0, held: true }
        }
        goTo(p)
        return
      }
      const off = new THREE.Vector3(
        ...screenPan(e.clientX - g.x0, e.clientY - g.y0, g.perPx, g.right, g.up)
      )
      const p = base()
      p.pos.copy(g.pos0).add(off)
      p.target.copy(g.target0).add(off)
      goTo(p)
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // Already released.
      }
      // An orbit let go: the marker stays a moment, then fades out.
      if (markerRef.current?.held)
        markerRef.current = {
          at: performance.now() / 1000 - MARKER_FADE_IN,
          held: false,
        }
      if (pointers.size === 0) {
        // A click, not a drag: the pivot moves to what was clicked. The
        // click itself goes on to the scene untouched.
        if (
          !dragged &&
          downAt?.button === 0 &&
          e.type === "pointerup" &&
          gesture?.mode !== "pinch" &&
          controls.enabled
        )
          setPivotAt(e.clientX, e.clientY)
        gesture = null
        downAt = null
        invalidate()
        return
      }
      // A finger lifted off a pinch: the other carries on from where it
      // is, without a jump.
      if (pointers.size === 1) {
        const [[id, p]] = [...pointers.entries()]
        startDrag(id, p.x, p.y, false, false)
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
  }, [gl, camera, scene, invalidate, requestRef, controls])

  // The framing calls, for keys and HUD buttons outside the canvas.
  useEffect(() => {
    const request = (to: { target: Vec3; position: Vec3 }) => {
      requestRef.current = {
        target: new THREE.Vector3(...to.target),
        position: new THREE.Vector3(...to.position),
      }
      invalidate()
    }
    const fovY = () =>
      isOrtho(camera) ? Math.PI / 4 : (camera.fov * Math.PI) / 180
    const aspect = () =>
      isOrtho(camera)
        ? (camera.right - camera.left) /
          Math.max(camera.top - camera.bottom, 1e-9)
        : camera.aspect
    const calls: NavApi = {
      frame(min, max, elevation = FRAME_ELEVATION) {
        const dir = viewDirection(
          tuple(camera.getWorldDirection(_fwd)),
          elevation
        )
        request(
          frameBox(min, max, dir, fovY(), aspect(), {
            minDist: opts.current.minDistance * 4,
          })
        )
      },
      fitAll() {
        const raw = opts.current.bounds
        const b = typeof raw === "function" ? raw() : raw
        if (!b) return
        request(
          frameBox(b.min, b.max, homeDir.current, fovY(), aspect(), {
            margin: 1.05,
          })
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
      // First nav key of a session: land any eased move, then pull the
      // orbit target to ~3 m ahead so the walk speed fits the near view.
      // Idempotent afterwards - key pans move camera and target together.
      if (pressed.current.size === 0) {
        const g = goalRef.current
        if (g) {
          camera.position.copy(g.pos)
          targetRef.current.copy(g.target)
          goalRef.current = null
        }
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

  // The nearest thing to the camera, for the near plane: the distance to
  // every visible mesh's box - floors, zones and walls too, which turn off
  // raycasting so they don't take clicks (a ray probe walked through them,
  // and the camera saw through a floor it hovered over). A box's distance is
  // never more than its surface's, so the plane stays in front of it.
  const probeSurface = (
    cam: THREE.PerspectiveCamera,
    reach: number
  ): number => {
    let best = Infinity
    scene.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh) || o === marker) return
      const inst = o instanceof THREE.InstancedMesh ? o : null
      if (inst && !inst.boundingBox) inst.computeBoundingBox()
      const g = o.geometry as THREE.BufferGeometry
      if (!inst && !g.boundingBox) g.computeBoundingBox()
      const box = inst ? inst.boundingBox : g.boundingBox
      if (!box || box.isEmpty()) return
      _probeBox.copy(box).applyMatrix4(o.matrixWorld)
      const d = _probeBox.distanceToPoint(cam.position)
      if (d < best) best = d
    })
    return best <= reach * 2 ? best : Infinity
  }

  useFrame((state, delta) => {
    const cam = state.camera as
      THREE.PerspectiveCamera | THREE.OrthographicCamera
    const tgt = targetRef.current
    const dt = Math.min(delta, MAX_NAV_DT)
    const reduced = prefersReducedMotion()
    // Settle loop: racks defer their LOD/panel swaps while the camera moves
    // (see camera-motion.ts), and with frameloop="demand" nothing else
    // promises a frame AFTER the motion window closes. Keep frames coming
    // through the window plus its tail, so the swap-applying frame always
    // arrives, whatever moved the camera.
    if (isCameraSettling()) invalidate()

    // Pick up a new request.
    if (requestRef.current) {
      const to = requestRef.current
      requestRef.current = null
      goalRef.current = null
      pivotRef.current = null
      const travel = Math.max(
        cam.position.distanceTo(to.position),
        tgt.distanceTo(to.target)
      )
      fly.current = {
        fromPos: tuple(cam.position),
        fromTarget: tuple(tgt),
        toPos: tuple(to.position),
        toTarget: tuple(to.target),
        duration: reduced ? 0 : flyDuration(travel),
        t: 0,
      }
    }
    const f = fly.current
    if (f) {
      const step = advanceFly(f, dt)
      f.t = step.t
      cam.position.set(...step.pos)
      tgt.set(...step.target)
      cam.lookAt(tgt)
      markCameraMoving()
      if (step.done) fly.current = null
      invalidate()
    } else if (goalRef.current) {
      // Ease toward where the hand put the camera.
      const g = goalRef.current
      const k = easeShare(dt, reduced)
      cam.position.lerp(g.pos, k)
      tgt.lerp(g.target, k)
      if (isOrtho(cam) && cam.zoom !== g.zoom) {
        cam.zoom += (g.zoom - cam.zoom) * k
        if (Math.abs(cam.zoom - g.zoom) <= g.zoom * 1e-4) cam.zoom = g.zoom
        cam.updateProjectionMatrix()
      }
      const eps = Math.max(1e-6, g.pos.distanceTo(g.target)) * 1e-4
      if (
        cam.position.distanceTo(g.pos) <= eps &&
        tgt.distanceTo(g.target) <= eps &&
        (!isOrtho(cam) || cam.zoom === g.zoom)
      ) {
        cam.position.copy(g.pos)
        tgt.copy(g.target)
        goalRef.current = null
      }
      cam.lookAt(tgt)
      markCameraMoving()
      invalidate()
    } else if (pressed.current.size > 0) {
      const keysDown = pressed.current
      // Forward = camera→target projected onto the ground plane.
      _fwd.copy(tgt).sub(cam.position)
      _fwd.y = 0
      if (_fwd.lengthSq() < 1e-8) {
        // Looking straight down: fall back to screen-up so arrows keep
        // meaning.
        _fwd.set(0, 1, 0).applyQuaternion(cam.quaternion)
        _fwd.y = 0
      }
      if (_fwd.lengthSq() > 1e-8) _fwd.normalize()
      const [dx, dy, dz] = panVector(
        keysDown,
        [_fwd.x, _fwd.z],
        cam.position.distanceTo(tgt),
        dt
      )
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        cam.position.x += dx
        cam.position.y += dy
        cam.position.z += dz
        tgt.x += dx
        tgt.y += dy
        tgt.z += dz
        if (opts.current.floor) {
          if (cam.position.y < CAMERA_MIN_Y) cam.position.y = CAMERA_MIN_Y
          if (tgt.y < TARGET_MIN_Y) tgt.y = TARGET_MIN_Y
        }
        cam.lookAt(tgt)
        markCameraMoving()
      }
      // Demand frameloop: keep frames coming while any nav key is held -
      // opposing keys can sum to zero, but a release must resume motion
      // without needing a fresh keydown.
      invalidate()
    }

    // Clip planes (perspective): the near plane stays in front of the
    // nearest surface in view, the far plane follows a zoom-out that has
    // no limit (see adaptiveNear). Rebuilt only past a 20% drift.
    if (!isOrtho(cam)) {
      cam.updateMatrixWorld()
      const toTarget = cam.position.distanceTo(tgt)
      let toSurface = Infinity
      if (toTarget * 0.02 > opts.current.minNear) {
        const now = performance.now()
        const pr = probeRef.current
        if (!pr || now - pr.at > PROBE_MS) {
          const depth = probeSurface(cam, toTarget * 0.02 * 4)
          probeRef.current = { depth, from: cam.position.clone(), at: now }
          toSurface = depth
        } else {
          // Between probes, assume the camera went straight at it.
          toSurface = Math.max(0, pr.depth - cam.position.distanceTo(pr.from))
        }
      }
      // A far the scene set (a viewer re-framing) becomes the base.
      if (!farRef.current || farRef.current.set !== cam.far)
        farRef.current = { base: cam.far, set: cam.far }
      const fr = farRef.current
      const far = adaptiveFar(toTarget, fr.base)
      const near = adaptiveNear({
        toTarget,
        toSurface,
        height: opts.current.floor ? cam.position.y : Infinity,
        min: opts.current.minNear,
        far,
      })
      if (near !== cam.near || far !== cam.far) {
        cam.near = near
        cam.far = far
        fr.set = far
        cam.updateProjectionMatrix()
      }
    }

    // The pivot marker: fades in on a click, full while an orbit turns.
    const m = markerRef.current
    const pivot = pivotRef.current
    if (m && pivot) {
      const t = m.held ? 0 : performance.now() / 1000 - m.at
      const o = markerOpacity(t, reduced, m.held)
      marker.material.opacity = o * 0.9
      marker.visible = o > 0
      marker.position.copy(pivot)
      const viewH = isOrtho(cam)
        ? (cam.top - cam.bottom) / cam.zoom
        : 2 *
          Math.max(cam.position.distanceTo(pivot), 1e-6) *
          Math.tan((cam.fov * Math.PI) / 360)
      marker.scale.setScalar(Math.max(viewH * MARKER_SHARE, 1e-9))
      // A held marker draws with the drag's own frames.
      if (m.held) return
      if (o > 0) invalidate()
      else {
        markerRef.current = null
        marker.visible = false
        invalidate()
      }
    } else if (marker.visible) {
      marker.visible = false
      invalidate()
    }
  })

  return <primitive object={marker} />
}
