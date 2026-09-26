import { describe, expect, it } from "vitest"

import { crosses } from "../__fixtures__/route-checks"
import {
  assignLanes,
  elbowBase,
  endTurn,
  LANE,
  MIN_STUB,
  obstacles,
  SHARED_STUB,
  sharedPins,
} from "./lanes"
import type { ElbowCable, PlanEnd } from "./lanes"
import type { Dir, Pt, Rect } from "./types"

// The elbow planner on small, hand-made cases.

const end = (
  x: number,
  y: number,
  dir: Dir,
  node: string,
  stub = 14,
  shared?: string
): PlanEnd => ({ x, y, dir, node, stub, ...(shared ? { shared } : {}) })

const cable = (key: string, a: PlanEnd, b: PlanEnd): ElbowCable => ({
  key,
  a,
  b,
})

const hitsBox = (pts: Pt[], r: Rect) =>
  pts.slice(1).some((q, i) => {
    const p = pts[i]
    const [x0, x1] = [Math.min(p.x, q.x), Math.max(p.x, q.x)]
    const [y0, y1] = [Math.min(p.y, q.y), Math.max(p.y, q.y)]
    return x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h
  })

const DOWN: Dir = [0, 1]
const UP: Dir = [0, -1]

describe("elbowBase", () => {
  const none = obstacles([])

  it("runs straight out of each port for its stub, crossing mid-gap", () => {
    const r = elbowBase(
      cable("c", end(0, 0, DOWN, "a", 60), end(200, 300, UP, "b", 40)),
      none
    )
    expect(r.pts).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 150 },
      { x: 200, y: 150 },
      { x: 200, y: 300 },
    ])
  })

  it("draws ends less than a pixel or two apart as one straight run", () => {
    const r = elbowBase(
      cable("c", end(100, 0, DOWN, "a"), end(100.4, 200, UP, "b")),
      none
    )
    expect(r.pts).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 200 },
    ])
  })

  it("moves a corridor off a card in the way, to the middle of the clear run", () => {
    const card = { x: -50, y: 120, w: 300, h: 40 }
    const r = elbowBase(
      cable("c", end(0, 0, DOWN, "a"), end(200, 300, UP, "b")),
      obstacles([["x", card]])
    )
    expect(hitsBox(r.pts, { ...card, y: card.y - 8, h: card.h + 16 })).toBe(
      false
    )
    // Not hard against the card: somewhere mid-run below or above it.
    const y = r.pts[1].y
    expect(y < 112 - LANE || y > 168 + LANE).toBe(true)
  })

  it("steps round a card on the straight run through a clear street", () => {
    // A card right under the source port, between it and the target row.
    const card = { x: -40, y: 80, w: 80, h: 60 }
    const r = elbowBase(
      cable("c", end(0, 0, DOWN, "a"), end(0, 300, UP, "b")),
      obstacles([["x", card]])
    )
    expect(hitsBox(r.pts, card)).toBe(false)
    expect(r.pts[0]).toEqual({ x: 0, y: 0 })
    expect(r.pts.at(-1)).toEqual({ x: 0, y: 300 })
  })

  it("gives up a port name's room before it runs behind a card", () => {
    // The only clear corridor runs 20-40 px above the target: short of
    // the 60 px its port name needs.
    const card = { x: 50, y: 20, w: 100, h: 230 }
    const r = elbowBase(
      cable("c", end(0, 0, DOWN, "a"), end(200, 300, UP, "b", 60)),
      obstacles([["x", card]])
    )
    const pad = { x: 42, y: 12, w: 116, h: 246 }
    expect(hitsBox(r.pts, pad)).toBe(false)
    const last = 300 - r.pts.at(-2)!.y
    expect(last).toBeLessThan(60)
    expect(last).toBeGreaterThanOrEqual(MIN_STUB)
  })

  it("holds a shared point's stagger depth", () => {
    const r = elbowBase(
      cable(
        "c",
        end(0, 0, DOWN, "a", SHARED_STUB, "p"),
        end(200, 300, UP, "b")
      ),
      none,
      SHARED_STUB + LANE
    )
    expect(r.pts[1]).toEqual({ x: 0, y: SHARED_STUB + LANE })
    expect(r.pinA).toBe(SHARED_STUB + LANE)
  })
})

describe("sharedPins", () => {
  it("turns each line off a shared point at its own depth, outermost first", () => {
    const p = "a|bottom"
    const pins = sharedPins([
      cable("near", end(0, 0, DOWN, "a", 8, p), end(100, 200, UP, "b")),
      cable("far", end(0, 0, DOWN, "a", 8, p), end(300, 200, UP, "c")),
      cable("left", end(0, 0, DOWN, "a", 8, p), end(-200, 200, UP, "d")),
      cable("on", end(0, 0, DOWN, "a", 8, p), end(0, 200, UP, "e")),
    ])
    // Turning right: the one going further round turns first.
    expect(pins.get("far:a")).toBe(SHARED_STUB)
    expect(pins.get("near:a")).toBe(SHARED_STUB + LANE)
    // Turning left has lanes of its own; straight on needs none.
    expect(pins.get("left:a")).toBe(SHARED_STUB)
    expect(pins.has("on:a")).toBe(false)
  })
})

describe("assignLanes", () => {
  it("parts cables sharing a corridor by a lane, nested so they never cross", () => {
    // Three cables out of one card's bottom, into three cards below and
    // to the right: one corridor for all three at first.
    const cables = [0, 1, 2].map((i) =>
      cable(
        `c${i}`,
        end(i * 16, 0, DOWN, "a"),
        end(400 + i * 120, 300, UP, `b${i}`)
      )
    )
    const o = obstacles([])
    const routes = cables.map((c) => elbowBase(c, o))
    expect(new Set(routes.map((r) => r.pts[1].y)).size).toBe(1)
    assignLanes(routes, cables, o)
    const ys = routes.map((r) => r.pts[1].y).sort((a, b) => a - b)
    expect(ys[1] - ys[0]).toBeCloseTo(LANE, 5)
    expect(ys[2] - ys[1]).toBeCloseTo(LANE, 5)
    for (let i = 0; i < routes.length; i++)
      for (let j = i + 1; j < routes.length; j++)
        for (let s = 1; s < routes[i].pts.length; s++)
          for (let t = 1; t < routes[j].pts.length; t++)
            expect(
              crosses(
                routes[i].pts[s - 1],
                routes[i].pts[s],
                routes[j].pts[t - 1],
                routes[j].pts[t]
              )
            ).toBe(false)
  })

  it("keeps a lane's run clear of a card beside the corridor", () => {
    const card = { x: 100, y: 160, w: 200, h: 60 }
    const cables = [0, 1, 2, 3].map((i) =>
      cable(`c${i}`, end(i * 16, 0, DOWN, "a"), end(400 + i * 16, 400, UP, "b"))
    )
    const o = obstacles([["x", card]])
    const routes = cables.map((c) => elbowBase(c, o))
    assignLanes(routes, cables, o)
    for (const r of routes) expect(hitsBox(r.pts, card)).toBe(false)
  })
})

describe("endTurn", () => {
  it("reads which way a route turns out of its port, how far out and to where", () => {
    const pts = [
      { x: 10, y: 0 },
      { x: 10, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 200 },
    ]
    expect(endTurn(pts, { x: 10, y: 0, dir: DOWN })).toEqual({
      turn: 1,
      depth: 50,
      extent: 300,
    })
  })
})
