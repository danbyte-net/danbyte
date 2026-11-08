import { useLayoutEffect, useRef } from "react"
import type { ReactNode } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import type * as THREE from "three"

import { smoothToward } from "@/components/floorplan/level-explode"
import type { ExplodeStore } from "@/components/floorplan/level-explode"

import { EXPLODE_M } from "./building-math"

/**
 * The building's explode, eased in the frame loop. The level panel only
 * sets a target (ExplodeStore); `ExplodeDriver` eases toward it each frame
 * and moves every registered level group by its storey step directly -
 * no React render per slider step or per frame, so nothing is rebuilt and
 * the camera is left alone.
 */

interface Entry {
  obj: THREE.Object3D
  /** Storeys from the active level (negative below). */
  step: number
  /** A stretched climb between two levels: its base height span and the
   * far end's step - scale.y follows the gap. */
  stretch?: { dy: number; stepB: number }
}

export interface ExplodeRegistry {
  /** The eased value now. */
  current: number
  entries: Set<Entry>
}

const registries = new WeakMap<ExplodeStore, ExplodeRegistry>()

/** The level groups `store` moves, and its eased value - one per store,
 * shared by the driver and every group inside the canvas. */
export function explodeRegistry(store: ExplodeStore): ExplodeRegistry {
  let r = registries.get(store)
  if (!r) {
    r = { current: store.get(), entries: new Set() }
    registries.set(store, r)
  }
  return r
}

/** Move one entry to the explode `e`. */
export function applyExplode(entry: Entry, e: number): void {
  const off = e * EXPLODE_M
  entry.obj.position.y = off * entry.step
  if (entry.stretch) {
    const sy = entry.stretch.dy + off * (entry.stretch.stepB - entry.step)
    entry.obj.scale.y = Math.abs(sy) < 1e-4 ? 1e-4 : sy
  }
}

/** Longest frame step the easing takes, s: a demand frameloop's first
 * frame after idle reports the whole idle time. */
const MAX_DT = 1 / 30

/** Eases the explode toward `store`'s value each frame and moves every
 * registered group. Mount it first inside the canvas, so the groups have
 * moved before anything else reads them in the same frame. */
export function ExplodeDriver({ store }: { store: ExplodeStore | null }) {
  const invalidate = useThree((s) => s.invalidate)
  // A slider step or a tween tick: the demand frameloop draws a frame.
  useLayoutEffect(
    () => store?.subscribe(() => invalidate()),
    [store, invalidate]
  )
  useFrame((_, delta) => {
    if (!store) return
    const registry = explodeRegistry(store)
    const target = store.get()
    const cur = registry.current
    if (cur === target) return
    const next = smoothToward(cur, target, Math.min(delta, MAX_DT))
    registry.current = next
    for (const entry of registry.entries) applyExplode(entry, next)
    if (next !== target) invalidate()
  })
  return null
}

function useRegister(
  store: ExplodeStore | null | undefined,
  ref: React.RefObject<THREE.Object3D | null>,
  step: number,
  stretch?: { dy: number; stepB: number }
) {
  const registry = store ? explodeRegistry(store) : null
  const dy = stretch?.dy
  const stepB = stretch?.stepB
  useLayoutEffect(() => {
    const obj = ref.current
    if (!obj) return
    const entry: Entry = {
      obj,
      step,
      stretch: dy != null && stepB != null ? { dy, stepB } : undefined,
    }
    applyExplode(entry, registry?.current ?? 0)
    registry?.entries.add(entry)
    return () => {
      registry?.entries.delete(entry)
    }
  }, [ref, registry, step, dy, stepB])
}

/** A level's contents at its base placement (`position`, `rotY`), lifted
 * by the eased explode times `step` storeys. The inner group's height is
 * the driver's; React never sets it. */
export function ExplodedGroup({
  explode,
  step,
  position,
  rotY = 0,
  children,
}: {
  /** No store: the group sits at its base placement. */
  explode?: ExplodeStore | null
  step: number
  position?: [number, number, number]
  rotY?: number
  children: ReactNode
}) {
  const inner = useRef<THREE.Group>(null)
  useRegister(explode, inner, step)
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <group ref={inner}>{children}</group>
    </group>
  )
}

/** A climb between two levels: `children` drawn from `from` to
 * `from + (dx, 1, dz)` - put the far end at y = 1 - stretched to the
 * gap between the two levels as they spread. */
export function ExplodeStretch({
  explode,
  from,
  dy,
  stepA,
  stepB,
  children,
}: {
  explode?: ExplodeStore | null
  from: [number, number, number]
  /** The climb's height at explode 0. */
  dy: number
  stepA: number
  stepB: number
  children: ReactNode
}) {
  const inner = useRef<THREE.Group>(null)
  useRegister(explode, inner, stepA, { dy, stepB })
  return (
    <group position={from}>
      <group ref={inner}>{children}</group>
    </group>
  )
}
