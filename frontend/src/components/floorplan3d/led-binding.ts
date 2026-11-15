import { useEffect } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"

import {
  BLINK_PERIOD_MS,
  blinkPhaseOn,
  ledLook,
  ledStateOf,
} from "@/lib/led-state"
import type { DeviceLeds, LedLook } from "@/lib/led-state"

/**
 * Status LEDs on an assembled model (docs/dcim/model-packs.md → Status
 * LEDs). A model's `led:<id>` nodes (their own mesh, or - gltfpack `-kn` -
 * their child meshes) wear the pack's dark `LED` material; here each one
 * found in a placed copy takes a shared glowing material for its state, or
 * gets its own dark one back when it is off.
 *
 * Materials are shared per look - one green, one blinking green… for every
 * LED in every canvas - so a hall of switches costs a handful of materials,
 * and a state change is a material swap: no geometry, no React render.
 *
 * Blinking: every blinking material is switched by one module-level clock
 * (a 2 Hz square wave, every light in step), which then asks each canvas
 * that shows a blinking light for one frame. The room draws on demand, so
 * that is two frames a second while something blinks and none otherwise -
 * no per-LED state, no render per tick. With prefers-reduced-motion the
 * lights hold steady and the clock never starts.
 */

/** A bound light: where it is (chassis or a module's bay), its meshes and
 * their own (dark) materials. */
export interface BoundLed {
  name: string
  bay: string | null
  meshes: THREE.Mesh[]
  own: (THREE.Material | THREE.Material[])[]
}

/** The `led:` nodes of a placed copy, with the bay each sits in (the
 * nearest part root model-assembly tagged `danbyteBay`). A node's meshes
 * are its own and its descendants'. */
export function findLeds(root: THREE.Object3D): BoundLed[] {
  const out: BoundLed[] = []
  const seen = new Set<string>()
  root.traverse((o) => {
    const n = o.userData.gltfName
    if (typeof n !== "string" || !n.startsWith("led:") || n.length <= 4) return
    let bay: string | null = null
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
      if (typeof p.userData.danbyteBay === "string") {
        bay = p.userData.danbyteBay
        break
      }
    }
    const key = `${bay ?? ""}\u0001${n}`
    if (seen.has(key)) return
    seen.add(key)
    const meshes: THREE.Mesh[] = []
    o.traverse((c) => {
      if (c instanceof THREE.Mesh) meshes.push(c)
    })
    out.push({
      name: n.slice(4),
      bay,
      meshes,
      own: meshes.map((m) => m.material),
    })
  })
  return out
}

// The blink clock's state (see "the shared blink clock" below).
let phaseOn = true
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

const materials = new Map<string, THREE.MeshStandardMaterial>()
/** The blinking materials and their lit strength. */
const blinking = new Map<THREE.MeshStandardMaterial, number>()

/** The shared material for a lit look. */
export function ledMaterial(look: LedLook): THREE.MeshStandardMaterial | null {
  if (!look.color) return null
  const key = `${look.base}|${look.blink ? 1 : 0}`
  let m = materials.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      name: `LED ${key}`,
      color: "#111111",
      roughness: 0.4,
      emissive: new THREE.Color(look.color),
      emissiveIntensity: look.strength,
      toneMapped: false,
    })
    materials.set(key, m)
    if (look.blink) {
      blinking.set(m, look.strength)
      m.emissiveIntensity = phaseOn ? look.strength : 0
    }
  }
  return m
}

/**
 * Put each bound light in its state from `dev` (null: every light off).
 * Returns whether any of them blinks.
 */
export function applyLeds(
  bound: readonly BoundLed[],
  dev: DeviceLeds | null | undefined,
  reducedMotion: boolean
): boolean {
  let anyBlink = false
  for (const led of bound) {
    const look = ledLook(ledStateOf(dev, led.name, led.bay), reducedMotion)
    const mat = ledMaterial(look)
    if (look.blink) anyBlink = true
    led.meshes.forEach((m, i) => {
      m.material = mat ?? led.own[i]
    })
  }
  return anyBlink
}

// ── the shared blink clock ──────────────────────────────────────────────────

function tick() {
  const on = blinkPhaseOn(Date.now())
  if (on === phaseOn) return
  phaseOn = on
  for (const [m, strength] of blinking) m.emissiveIntensity = on ? strength : 0
  listeners.forEach((fn) => fn())
}

/** Join the clock (`fn` is asked for a frame on every flip); returns the
 * leave function. The clock runs while anyone has joined. */
export function joinBlinkClock(fn: () => void): () => void {
  listeners.add(fn)
  if (!timer) timer = setInterval(tick, BLINK_PERIOD_MS / 8)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** For tests: the clock's state. */
export function blinkClockRunning(): boolean {
  return timer !== null
}

/** Keep this canvas drawing the blink while `active`. */
export function useLedBlink(active: boolean) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (!active) return
    return joinBlinkClock(() => invalidate())
  }, [active, invalidate])
}
