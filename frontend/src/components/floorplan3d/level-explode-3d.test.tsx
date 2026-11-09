// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import * as THREE from "three"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanFloor } from "@/lib/api"
import { createExplodeStore } from "@/components/floorplan/level-explode"

import { EXPLODE_M, levelsBounds, placeLevels } from "./building-math"
import {
  applyExplode,
  ExplodeDriver,
  explodeRegistry,
} from "./level-explode-3d"
import { Stage, STAGE_SHADOWS, roomLights } from "./stage"

// Moving the Explode slider used to re-render the whole editor and the
// 3D scene per step: the canvas re-ran its configure (the deprecated soft
// shadow map flagged for a rebuild and warned each time), the levels'
// lines were rebuilt and the camera re-aimed at the moved building. Now
// the slider sets a store and the frame loop moves the level groups.

const h = vi.hoisted(() => ({
  invalidate: vi.fn(),
  frame: null as null | ((s: unknown, delta: number) => void),
  canvasProps: [] as Record<string, unknown>[],
}))
vi.mock("@react-three/fiber", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useThree: (pick: (s: { invalidate: () => void }) => unknown) =>
    pick({ invalidate: h.invalidate }),
  useFrame: (fn: (s: unknown, delta: number) => void) => {
    h.frame = fn
  },
  Canvas: (props: Record<string, unknown>) => {
    h.canvasProps.push(props)
    return null
  },
}))

beforeEach(() => {
  h.invalidate.mockReset()
  h.frame = null
  h.canvasProps.length = 0
})
afterEach(cleanup)

const floor = (id: string, elevation: number): FloorPlanFloor => ({
  id,
  numid: null,
  name: id,
  floor_order: 0,
  location_id: null,
  kind: "plan",
  elevation,
  grid_width: 20,
  grid_height: 10,
  cell_mm: 500,
})
const floors = [floor("b1", -3300), floor("g", 0), floor("1", 3300)]

describe("the canvas config", () => {
  it("is the same objects across a re-render, PCF shadows stated", () => {
    const stage = (n: number) => (
      <Stage
        quality="medium"
        // A fresh object each render, as the scene passes it.
        camera={{ position: [1, 2, 3], far: 100 }}
        lights={roomLights(10, 10, 10)}
        controls={{
          target: [0, 0, 0],
          maxDistance: 50,
          requestRef: { current: null },
        }}
        stamp={String(n)}
      >
        {null}
      </Stage>
    )
    const { rerender } = render(stage(1))
    rerender(stage(2))
    expect(h.canvasProps).toHaveLength(2)
    const [a, b] = h.canvasProps
    for (const k of ["shadows", "dpr", "camera", "frameloop"])
      expect(b[k], k).toBe(a[k])
    expect(a.shadows).toBe(STAGE_SHADOWS)
    expect(STAGE_SHADOWS.type).toBe(THREE.PCFShadowMap)
    expect(a.camera).toMatchObject({ position: [1, 2, 3], far: 100, fov: 45 })
  })
})

describe("the explode", () => {
  it("leaves the levels, their geometry and the camera's target alone", () => {
    // The scene places its levels at explode 0 whatever the slider says;
    // the opening view's target comes from those.
    const base = placeLevels(floors, "g", "all", 0)
    const store = createExplodeStore(0)
    const before = levelsBounds(base, 10, 5)
    store.set(1)
    expect(placeLevels(floors, "g", "all", 0)).toEqual(base)
    expect(levelsBounds(base, 10, 5)).toEqual(before)
    // Fit all reads the spread as it stands.
    const spread = levelsBounds(base, 10, 5, store.get())!
    expect(spread.max[1] - before!.max[1]).toBeCloseTo(EXPLODE_M)
    expect(before!.min[1] - spread.min[1]).toBeCloseTo(EXPLODE_M)
  })

  it("lifts a level by its steps and stretches a climb to the gap", () => {
    const g = new THREE.Group()
    applyExplode({ obj: g, step: 2 }, 0.5)
    expect(g.position.y).toBeCloseTo(EXPLODE_M)
    const climb = new THREE.Group()
    applyExplode({ obj: climb, step: -1, stretch: { dy: 3.3, stepB: 0 } }, 1)
    expect(climb.position.y).toBeCloseTo(-EXPLODE_M)
    expect(climb.scale.y).toBeCloseTo(3.3 + EXPLODE_M)
  })

  it("eases the groups in the frame loop", () => {
    const store = createExplodeStore(0)
    const registry = explodeRegistry(store)
    const g = new THREE.Group()
    registry.entries.add({ obj: g, step: 1 })
    render(<ExplodeDriver store={store} />)
    store.set(1)
    // The slider step asked for a frame.
    expect(h.invalidate).toHaveBeenCalled()
    let last = 0
    for (let i = 0; i < 6; i++) {
      h.frame!({}, 1 / 60)
      expect(g.position.y).toBeGreaterThan(last)
      expect(g.position.y).toBeLessThan(EXPLODE_M)
      last = g.position.y
    }
    for (let i = 0; i < 200; i++) h.frame!({}, 1 / 60)
    expect(g.position.y).toBeCloseTo(EXPLODE_M)
    expect(registry.current).toBe(1)
    // Settled: no more frames asked for.
    h.invalidate.mockReset()
    h.frame!({}, 1 / 60)
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it("takes a long idle gap as one short step, not a jump", () => {
    const store = createExplodeStore(0)
    const g = new THREE.Group()
    explodeRegistry(store).entries.add({ obj: g, step: 1 })
    render(<ExplodeDriver store={store} />)
    store.set(1)
    h.frame!({}, 5)
    expect(g.position.y).toBeGreaterThan(0)
    expect(g.position.y).toBeLessThan(EXPLODE_M / 2)
  })
})
