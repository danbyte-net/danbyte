import { useEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"
import * as THREE from "three"

import { markCameraMoving, settleDelayMs } from "./camera-motion"
import {
  MIN_DISTANCE_M,
  NAV_KEYS,
  PAGE_SCROLL_KEYS,
  dollyThroughStep,
  nearForDistance,
  normalizeKey,
  panVector,
  pullInTarget,
  zoomSpeedForRoom,
} from "./camera-math"

export interface FlyToRequest {
  target: THREE.Vector3
  position: THREE.Vector3
}

/** Keyboard pan never drives the camera below (near) the slab. */
const CAMERA_MIN_Y = 0.1

/** The orbit target stays a hair above the floor so orbiting stays sane. */
const TARGET_MIN_Y = 0.05

/**
 * Cap on the per-frame dt fed to the pan math: after a tab switch or GC
 * stall the frame delta can be seconds, and one uncapped step would
 * teleport the camera across the room.
 */
const MAX_NAV_DT = 0.1

/** Keydown targets that own the keyboard — navigation must not steal keys. */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

const isEditableTarget = (t: EventTarget | null) =>
  t instanceof Element && t.closest(EDITABLE_SELECTOR) !== null

// Scratch vector reused across frames (useFrame is synchronous).
const _fwd = new THREE.Vector3()

/**
 * OrbitControls plus an animated fly-to: push a request into `requestRef` and
 * the rig eases the camera + orbit target there over ~0.7 s. Works with
 * `frameloop="demand"` — the rig invalidates every animation frame itself.
 *
 * Also owns keyboard navigation: arrows / WASD pan the camera AND the orbit
 * target parallel to the ground plane (forward = camera→target projected to
 * XZ), Space rises, C descends (PageUp/PageDown too), Shift sprints ×4.
 * Speed scales with the orbit distance (see `camera-math.ts`). A nav keypress
 * cancels an in-flight fly-to. Listeners live on `window` but the rig only
 * exists while the 3D view is mounted, so 2D editing never sees them.
 */
export function CameraRig({
  target,
  maxDistance,
  roomDiag,
  requestRef,
}: {
  target: [number, number, number]
  maxDistance: number
  /** Larger room side (m) — scales the wheel so hall size doesn't change feel. */
  roomDiag: number
  requestRef: React.MutableRefObject<FlyToRequest | null>
}) {
  const controls = useRef<OrbitControlsImpl>(null)
  const invalidate = useThree((s) => s.invalidate)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const anim = useRef<{
    fromPos: THREE.Vector3
    fromTarget: THREE.Vector3
    to: FlyToRequest
    t: number
  } | null>(null)
  const pressed = useRef<Set<string>>(new Set())

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Leave browser/app shortcuts (Alt+Left history, Ctrl+A…) alone.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(e.target)) return
      const key = normalizeKey(e.key)
      if (!NAV_KEYS.has(key)) return
      // Only keys whose default scrolls the page; w/a/s/d/c/Shift stay
      // untouched (and Escape is never ours — connect/trace flows own it).
      if (PAGE_SCROLL_KEYS.has(key)) e.preventDefault()
      // First nav key of a session: pull the orbit pivot to ~3 m ahead so
      // drag-look feels first-person while walking (fly-to re-anchors it on
      // a rack for inspection). Idempotent afterwards - key pans move camera
      // and target together, so their distance stays put.
      if (pressed.current.size === 0) {
        const c = controls.current
        if (c) {
          const pulled = pullInTarget(
            [camera.position.x, camera.position.y, camera.position.z],
            [c.target.x, c.target.y, c.target.z]
          )
          if (pulled) {
            c.target.set(pulled[0], pulled[1], pulled[2])
            c.update()
          }
        }
      }
      pressed.current.add(key)
      // Driving the camera overrides an in-flight (or just-requested) fly-to.
      anim.current = null
      requestRef.current = null
      // frameloop="demand": kick the loop; useFrame keeps it alive from here.
      invalidate()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      // No guards on release: a key that went down must always come back up,
      // even if focus moved into a field or a modifier joined mid-hold.
      pressed.current.delete(normalizeKey(e.key))
      // Racks defer their LOD swap while the camera moves; the demand loop
      // stops on release, so without this trailing frame the pending swaps
      // would never run and the room would stay coarse until you nudged it.
      if (pressed.current.size === 0)
        window.setTimeout(invalidate, settleDelayMs() + 32)
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
  }, [invalidate, requestRef, camera])

  // Dolly-through: OrbitControls' multiplicative dolly collapses to nothing
  // at minDistance — the "zoom just stops" wall. At the wall, a wheel-in
  // stops shortening the arm and instead walks camera + target forward along
  // the sight line (orbit becomes fly — through the rack, into the aisle
  // behind it). Capture phase on the canvas's PARENT: capture on an ancestor
  // fires before OrbitControls' own target-phase listener, and a same-element
  // listener would lose the registration-order race. When the walk claims the
  // event, OrbitControls never sees it.
  useEffect(() => {
    const el = gl.domElement.parentElement
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const c = controls.current
      if (!c) return
      const step = dollyThroughStep(
        [camera.position.x, camera.position.y, camera.position.z],
        [c.target.x, c.target.y, c.target.z],
        e.deltaY,
        c.getDistance()
      )
      if (!step) return
      e.preventDefault()
      e.stopPropagation()
      camera.position.x += step[0]
      camera.position.y += step[1]
      camera.position.z += step[2]
      c.target.x += step[0]
      c.target.y += step[1]
      c.target.z += step[2]
      if (camera.position.y < CAMERA_MIN_Y) camera.position.y = CAMERA_MIN_Y
      if (c.target.y < TARGET_MIN_Y) c.target.y = TARGET_MIN_Y
      // Walking overrides an in-flight fly-to, same as a nav keypress.
      anim.current = null
      requestRef.current = null
      markCameraMoving()
      c.update()
      invalidate()
    }
    el.addEventListener("wheel", onWheel, { capture: true, passive: false })
    return () => el.removeEventListener("wheel", onWheel, { capture: true })
  }, [gl, camera, invalidate, requestRef])

  useFrame((state, delta) => {
    const c = controls.current
    if (!c) return
    // Floor clamp: maxPolarAngle now allows looking up from below the pivot,
    // so an orbit drag could push the eye underground - catch it on any frame
    // that renders (drag frames do, via the controls' change -> invalidate).
    if (state.camera.position.y < CAMERA_MIN_Y) {
      state.camera.position.y = CAMERA_MIN_Y
      c.update()
    }
    // Dynamic near-plane: 1 cm nose-on, 0.5 m across the hall — a fixed near
    // small enough for faceplates would shimmer the 3 mm floor overlays from
    // a distance (depth precision). Re-fit only past 20% drift so the
    // projection isn't rebuilt every frame; runs only on frames something
    // else already rendered, so it adds no invalidation source of its own.
    const cam = state.camera as THREE.PerspectiveCamera
    const near = nearForDistance(c.getDistance())
    if (Math.abs(near - cam.near) / cam.near > 0.2) {
      cam.near = near
      cam.updateProjectionMatrix()
    }
    // Pick up a new request.
    if (requestRef.current) {
      anim.current = {
        fromPos: state.camera.position.clone(),
        fromTarget: c.target.clone(),
        to: requestRef.current,
        t: 0,
      }
      requestRef.current = null
    }
    const a = anim.current
    if (a) {
      a.t = Math.min(1, a.t + delta / 0.7)
      // easeInOutCubic
      const k = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2
      state.camera.position.lerpVectors(a.fromPos, a.to.position, k)
      c.target.lerpVectors(a.fromTarget, a.to.target, k)
      markCameraMoving()
      c.update()
      if (a.t >= 1) anim.current = null
      else invalidate()
    }
    // Keyboard pan. A fly-to owns the frame while it runs (nav keydown
    // cancels it, so overlap only lasts until the next keydown anyway).
    if (anim.current) return
    const keysDown = pressed.current
    if (keysDown.size === 0) return
    // Forward = camera→target projected onto the ground plane.
    _fwd.copy(c.target).sub(state.camera.position)
    _fwd.y = 0
    if (_fwd.lengthSq() < 1e-8) {
      // Looking straight down: fall back to screen-up so arrows keep meaning.
      _fwd.set(0, 1, 0).applyQuaternion(state.camera.quaternion)
      _fwd.y = 0
    }
    if (_fwd.lengthSq() > 1e-8) _fwd.normalize()
    const [dx, dy, dz] = panVector(
      keysDown,
      [_fwd.x, _fwd.z],
      state.camera.position.distanceTo(c.target),
      Math.min(delta, MAX_NAV_DT)
    )
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      state.camera.position.x += dx
      state.camera.position.y += dy
      state.camera.position.z += dz
      c.target.x += dx
      c.target.y += dy
      c.target.z += dz
      if (state.camera.position.y < CAMERA_MIN_Y)
        state.camera.position.y = CAMERA_MIN_Y
      if (c.target.y < TARGET_MIN_Y) c.target.y = TARGET_MIN_Y
      markCameraMoving()
      c.update()
    }
    // Demand frameloop: keep frames coming while any nav key is held —
    // opposing keys can sum to zero, but a release must resume motion
    // without needing a fresh keydown.
    invalidate()
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={target}
      // Dolly toward the pointer, not the (possibly distant) orbit target —
      // on a hall-sized plan, plain dolly could never reach a far corner.
      zoomToCursor
      // The camera STOPS when the mouse stops. Drei enables damping by
      // default, which keeps easing the orbit for a while after you let go —
      // it reads as the room sliding out from under you, and on a hall-sized
      // plan you overshoot whatever you were trying to look at.
      enableDamping={false}
      maxPolarAngle={Math.PI - 0.05}
      minDistance={MIN_DISTANCE_M}
      maxDistance={maxDistance}
      zoomSpeed={zoomSpeedForRoom(roomDiag)}
    />
  )
}
