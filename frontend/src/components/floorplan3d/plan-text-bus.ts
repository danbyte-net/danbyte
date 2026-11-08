import type * as THREE from "three"

import type { NameCandidate } from "@/components/floorplan/readable"

// The room's text shares one collision pass a frame. Each plan-text layer
// (one a level) hands its candidates in and is told which show; with
// Readable on, its name plates run the pass (readable-names.tsx) so plates
// and plan text never overlap, else PlanTextDriver runs it for the plan
// text alone. A layer never runs a frame of its own, so there is no order
// between the callbacks to get wrong.

export interface PlanTextCollector {
  /** This frame's candidates (screen px), ids unique across the room. */
  collect: (
    camera: THREE.Camera,
    size: { width: number; height: number }
  ) => NameCandidate[]
  /** The pass's winners: show those of yours, hide the rest. */
  apply: (kept: ReadonlySet<string>) => void
}

export interface PlanTextBus {
  collectors: Set<PlanTextCollector>
  /** The Readable plates are mounted and run the pass. */
  driven: number
}

export function createPlanTextBus(): PlanTextBus {
  return { collectors: new Set(), driven: 0 }
}

export function collectPlanText(
  bus: PlanTextBus,
  camera: THREE.Camera,
  size: { width: number; height: number }
): NameCandidate[] {
  const out: NameCandidate[] = []
  for (const c of bus.collectors) out.push(...c.collect(camera, size))
  return out
}

export function applyPlanText(bus: PlanTextBus, kept: ReadonlySet<string>) {
  for (const c of bus.collectors) c.apply(kept)
}
