import { Children, isValidElement } from "react"
import type { ReactElement, ReactNode } from "react"
import { describe, expect, it } from "vitest"

import { placedOf } from "./floor-device-mesh"
import { tileFootprintM } from "./device-model-ports"
import { TileGhostMesh } from "./tile-ghost-mesh"
import { rowAxes, tileStandsIn, tileWorldPose } from "./world"
import type { ScenePayload, SceneFloorDevice, SceneTile } from "./world"

const plan = { cell_mm: 600 } as ScenePayload["plan"]
const deg = (d: number) => (d * Math.PI) / 180

const tile = (over: Partial<SceneTile> = {}): SceneTile => ({
  id: "t",
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  orientation: 0,
  status: "",
  label: "",
  kind: "other",
  color: "#0ea5e9",
  is_zone: false,
  rack: null,
  ...over,
})

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>

/** Every element of a type in a rendered tree (function components are
 * not expanded - the ghost is one plain group of three.js intrinsics). */
function find(node: ReactNode, type: string, out: El[] = []): El[] {
  Children.forEach(node, (c) => {
    if (!isValidElement(c)) return
    const el = c as El
    if (el.type === type) out.push(el)
    find(el.props.children, type, out)
  })
  return out
}

describe("tileWorldPose - the 3D twin of the canvas transform", () => {
  it("keeps a grid tile where it always stood", () => {
    const p = tileWorldPose(plan, tile({ x: 2, y: 3, w: 2, h: 1 }))
    expect(p.centre[0]).toBeCloseTo(1.8)
    expect(p.centre[1]).toBeCloseTo(2.1)
    expect(p.footprint.w).toBeCloseTo(1.2)
    expect(p.footprint.d).toBeCloseTo(0.6)
    expect(p.residualRotY).toBe(0)
    expect(p.rotY).toBe(0)
  })

  it("turns a fractional free tile at 28° about its centre", () => {
    const p = tileWorldPose(
      plan,
      tile({ x: 10.25, y: 4.5, w: 1.5, h: 4, orientation: 28 })
    )
    expect(p.centre[0]).toBeCloseTo(11 * 0.6)
    expect(p.centre[1]).toBeCloseTo(6.5 * 0.6)
    expect(p.residualRotY).toBeCloseTo(-deg(28))
    expect(p.rotY).toBeCloseTo(-deg(28))
  })

  it("faces a 118° tile by its whole turn with its own size swapped back", () => {
    const p = tileWorldPose(plan, tile({ w: 2, h: 1, orientation: 118 }))
    expect(p.rotY).toBeCloseTo(-deg(118))
    expect(p.residualRotY).toBeCloseTo(-deg(28))
    // Stored at its 90° footprint (2 × 1): facing 0° it is 1 wide, 2 deep.
    expect(p.local.w).toBeCloseTo(0.6)
    expect(p.local.d).toBeCloseTo(1.2)
    // The fitted-model footprint agrees.
    const f = tileFootprintM(plan, { w: 2, h: 1, orientation: 118 })
    expect(f.w).toBeCloseTo(0.6)
    expect(f.d).toBeCloseTo(1.2)
  })

  it("draws 208° as the same box as 28° on a symmetric footprint", () => {
    const a = tileWorldPose(plan, tile({ w: 1, h: 2, orientation: 208 }))
    expect(a.residualRotY).toBeCloseTo(-deg(28))
    expect(a.rotY).toBeCloseTo(-deg(208))
    expect(a.local.w).toBeCloseTo(0.6)
    expect(a.local.d).toBeCloseTo(1.2)
  })

  it("places a floor device at the tile's turned centre and facing", () => {
    const dev = {
      id: "d",
      name: "ups",
      u_height: 0,
      width_mm: 600,
      height_mm: 1800,
      depth_mm: 900,
      model: null,
    } as unknown as SceneFloorDevice
    const scene = { plan, raised_floors: [] } as unknown as ScenePayload
    const p = placedOf(
      scene,
      tile({ x: 3.5, y: 1.25, w: 2, h: 1, orientation: 118, device: dev })
    )!
    expect(p.centre[0]).toBeCloseTo(4.5 * 0.6)
    expect(p.centre[1]).toBeCloseTo(1.75 * 0.6)
    expect(p.rotY).toBeCloseTo(-deg(118))
    expect(p.footprint.w).toBeCloseTo(0.6)
    expect(p.footprint.d).toBeCloseTo(1.2)
  })
})

describe("a planning tile's ghost", () => {
  it("is one box at the tile's centre, turned by its residual", () => {
    const t = tile({ x: 640.5, y: 620.25, w: 1.5, h: 4, orientation: 28 })
    const tree = TileGhostMesh({ plan, tile: t, showName: false })
    const groups = find(tree, "group")
    expect(groups).toHaveLength(1)
    const g = groups[0].props as {
      position: [number, number, number]
      rotation: [number, number, number]
    }
    expect(g.position[0]).toBeCloseTo((640.5 + 0.75) * 0.6)
    expect(g.position[1]).toBe(0)
    expect(g.position[2]).toBeCloseTo((620.25 + 2) * 0.6)
    expect(g.rotation[1]).toBeCloseTo(-deg(28))
    // The massing and its base plate, both centred in the turned group.
    const meshes = find(tree, "mesh")
    expect(meshes).toHaveLength(2)
    const boxes = find(tree, "boxGeometry").map((b) => b.props.args as number[])
    expect(boxes[0][0]).toBeCloseTo(0.9 * 0.94)
    expect(boxes[0][2]).toBeCloseTo(2.4 * 0.94)
    for (const m of meshes) {
      const pos = m.props.position as number[]
      expect([pos[0], pos[2]]).toEqual([0, 0])
    }
  })

  it("stays an unturned box on a grid plan", () => {
    const tree = TileGhostMesh({
      plan,
      tile: tile({ x: 2, y: 2, w: 2, h: 1, orientation: 90 }),
      showName: false,
    })
    const g = find(tree, "group")[0].props as {
      position: number[]
      rotation: number[]
    }
    expect(g.rotation[1]).toBe(0)
    expect(g.position[0]).toBeCloseTo(1.8)
    expect(g.position[2]).toBeCloseTo(1.5)
  })
})

describe("zones and rows on a turned plan", () => {
  // A 12 × 2 hot aisle turned 28° about (6, 1), and a rack standing in it
  // half way along: inside the turned aisle, though outside its stored rect.
  const aisle = tile({
    x: 0,
    y: 0,
    w: 12,
    h: 2,
    orientation: 28,
    is_zone: true,
  })
  const along = (d: number): SceneTile => {
    const a = deg(28)
    const cx = 6 + d * Math.cos(a)
    const cy = 1 + d * Math.sin(a)
    return tile({ x: cx - 0.5, y: cy - 0.5, orientation: 28 })
  }

  it("finds the tiles standing in a turned zone by their centres", () => {
    expect(tileStandsIn(along(5), aisle)).toBe(true)
    expect(along(5).y).toBeGreaterThan(2)
    // Beside the aisle, across it.
    const beside = tile({
      x: 6 - 0.5 - 2 * Math.sin(deg(28)),
      y: 1 + 2 * Math.cos(deg(28)) - 0.5,
      orientation: 28,
    })
    expect(tileStandsIn(beside, aisle)).toBe(false)
  })

  it("keeps the grid overlap rule when nothing is turned", () => {
    const zone = tile({ x: 0, y: 0, w: 4, h: 2, is_zone: true })
    expect(tileStandsIn(tile({ x: 3.5, y: 1.5 }), zone)).toBe(true)
    expect(tileStandsIn(tile({ x: 4, y: 0 }), zone)).toBe(false)
  })

  it("walks a turned row along the anchor's own axis", () => {
    const anchor = along(0)
    const axes = rowAxes(anchor)
    expect(axes(along(4)).sameY).toBe(true)
    expect(axes(along(-3)).sameY).toBe(true)
    const nextRow = tile({
      x: anchor.x - 3 * Math.sin(deg(28)),
      y: anchor.y + 3 * Math.cos(deg(28)),
      orientation: 28,
    })
    expect(axes(nextRow).sameY).toBe(false)
    expect(axes(nextRow).sameX).toBe(true)
  })
})
