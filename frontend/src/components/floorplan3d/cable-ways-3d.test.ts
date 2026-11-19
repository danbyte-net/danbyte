import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { CableWayStore } from "@/lib/cable-way-store"

import { ownBoxes, rangeAt, tubeInto } from "./cable-ways-3d"
import type { ScenePathway } from "./way-geometry"

describe("the merged cables mesh", () => {
  it("builds one ring per point and finds a picked triangle's cable", () => {
    const out = { pos: [], nrm: [], col: [], idx: [] } as {
      pos: number[]
      nrm: number[]
      col: number[]
      idx: number[]
    }
    const c = new THREE.Color("#2563eb")
    tubeInto([[0, 0, 0], [0, 1, 0], [1, 1, 0]], 0.003, 6, c, out)
    expect(out.pos.length / 3).toBe(3 * 6)
    expect(out.idx.length / 3).toBe(2 * 6 * 2)
    // Every ring point is the radius from its centre.
    const r = Math.hypot(out.pos[0], out.pos[1], out.pos[2])
    expect(r).toBeCloseTo(0.003, 9)
    const ranges = [
      { start: 0, end: 24, cableId: "a" },
      { start: 24, end: 60, cableId: "b" },
    ]
    expect(rangeAt(ranges, 0)).toBe("a")
    expect(rangeAt(ranges, 30)).toBe("b")
    expect(rangeAt(ranges, 60)).toBeNull()
  })
})

describe("the pick store", () => {
  it("selects, toggles and tells its readers", () => {
    const s = new CableWayStore()
    let n = 0
    s.subscribe(() => n++)
    s.select("c1")
    s.select("c1")
    s.toggle("c1")
    expect(s.selected).toBeNull()
    expect(n).toBe(2)
  })
})

describe("Danbyte's own managers", () => {
  it("draws a channel open on its cables' side, with fingers at its pitch", () => {
    const p: ScenePathway = {
      key: "path:vertical:left:full",
      id: null,
      source: "default",
      kind: "vertical",
      subkind: "finger",
      side: "left",
      face: "full",
      surface: "",
      u_from: 1,
      u_to: 2,
      inner_w_mm: 150,
      inner_d_mm: 120,
      fill_limit_pct: 40,
      label: "Left",
      addon: false,
      geo: {
        x0: -454,
        x1: -300,
        y0: 438,
        y1: 562,
        z0: 100,
        z1: 188.9,
        cx: -377,
        cy: 500,
        wall: 2,
        open: "front",
        pitch_mm: 44.45,
      },
    }
    const boxes = ownBoxes(new Map([[p.key, p]]), 1, null)
    // Three walls (the front is open) and two fingers per pitch.
    expect(boxes.length).toBe(3 + 2 * 2)
    for (const b of boxes) {
      expect(b.c[0]).toBeGreaterThan(0.29)
      expect(b.c[0]).toBeLessThan(0.46)
    }
  })
})
