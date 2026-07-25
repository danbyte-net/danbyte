import { useEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"
import * as THREE from "three"

import {
  NAV_KEYS,
  PAGE_SCROLL_KEYS,
  normalizeKey,
  panVector,
  pullInTarget,
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
 * XZ), Space rises and Shift descends (PageUp/PageDown too). Speed scales
 * with the orbit distance (see `camera-math.ts`). A nav keypress cancels an
 * in-flight fly-to. Listeners live on `window` but the rig only exists while
 * the 3D view is mounted, so 2D editing never sees them.
 */
export function CameraRig({
  target,
  maxDistance,
  requestRef,
}: {
  target: [number, number, number]
  maxDistance: number
  requestRef: React.MutableRefObject<FlyToRequest | null>
}) {
  const controls = useRef<OrbitControlsImpl>(null)
  const invalidate = useThree((s) => s.invalidate)
  const camera = useThree((s) => s.camera)
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
      // Only keys whose default scrolls the page; w/a/s/d/q/e stay untouched
      // (and Escape is never ours — the connect/trace flows own it).
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
      maxPolarAngle={Math.PI - 0.05}
      minDistance={0.5}
      maxDistance={maxDistance}
    />
  )
}
