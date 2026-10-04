import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"

import { MIN_ZOOM, OPEN_ZOOM, openingPart } from "./opening-view"
import type { Box } from "./opening-view"

const node = (id: string, x: number, y: number, type = "card"): Node => ({
  id,
  type,
  position: { x, y },
  data: {},
})
const edge = (source: string, target: string): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
})
const ids = (nodes: Node[]) => nodes.map((n) => n.id).sort()
/** Every card 100 x 40 at its position. */
const box = (n: Node): Box => ({
  x: n.position.x,
  y: n.position.y,
  width: 100,
  height: 40,
})
/** A screen that shows 1,000 x 1,000 of the map. */
const fits = (b: Box) => b.width <= 1000 && b.height <= 1000
const part = (nodes: Node[], edges: Edge[], focus?: string) =>
  ids(openingPart(nodes, edges, box, fits, focus))

describe("openingPart", () => {
  // A leaf pair on a core, a server on each leaf, and a row of devices
  // nothing is cabled to far below - most of a big site.
  const nodes = [
    node("core", 0, 0),
    node("leaf1", -200, 200),
    node("leaf2", 200, 200),
    node("srv1", -200, 400),
    node("srv2", 200, 400),
    ...Array.from({ length: 50 }, (_, i) => node(`lone${i}`, i * 300, 9000)),
    node("zone:z", 0, 0, "zone"),
  ]
  const edges = [
    edge("core", "leaf1"),
    edge("core", "leaf2"),
    edge("leaf1", "srv1"),
    edge("leaf2", "srv2"),
    edge("leaf1", "leaf2"),
  ]

  it("opens on the most-cabled device, what is cabled to it and what is near", () => {
    // leaf1 and leaf2 have three each; leaf1 comes first in reading order.
    // The far row does not fit on screen with them.
    expect(part(nodes, edges)).toEqual([
      "core",
      "leaf1",
      "leaf2",
      "srv1",
      "srv2",
    ])
  })

  it("opens on the focused device when it is on the map", () => {
    expect(part(nodes, edges, "lone20")).toEqual([
      "lone18",
      "lone19",
      "lone20",
      "lone21",
    ])
    expect(part(nodes, edges, "gone")).toContain("leaf1")
  })

  it("leaves out the cabled devices that would not fit with it", () => {
    // A firewall cabled to its servers and to firewalls far away.
    const spread = [
      node("fw1", 0, 0),
      node("srv1", 0, 100),
      node("srv2", 150, 100),
      node("fw2", 0, 60_000),
      node("fw3", 0, 20_000),
    ]
    const links = ["srv1", "srv2", "fw2", "fw3"].map((x) => edge("fw1", x))
    expect(part(spread, links)).toEqual(["fw1", "srv1", "srv2"])
  })

  it("counts a breakout's far devices through its junction", () => {
    const fan = [
      node("fw", 0, 0),
      node("fan:1", 0, 50, "junction"),
      node("a", -100, 100),
      node("b", 0, 100),
      node("c", 100, 100),
    ]
    const links = [
      edge("fw", "fan:1"),
      ...["a", "b", "c"].map((x) => edge("fan:1", x)),
    ]
    expect(part(fan, links)).toEqual(["a", "b", "c", "fw"])
  })

  it("skips hidden cards and has nothing for a map without cards", () => {
    const hidden = nodes.map((n) =>
      n.id === "leaf1" ? { ...n, hidden: true } : n
    )
    expect(part(hidden, edges)).not.toContain("leaf1")
    expect(part([node("zone:z", 0, 0, "zone")], [])).toEqual([])
  })

  it("opens a big map on cabled cards close enough to read", () => {
    // A core and its twelve leaves, and 6,000 devices nothing is cabled
    // to packed in a grid right under them - most of a large site.
    const W = 1600
    const H = 900
    const PAD = 0.15
    const zoomFor = (b: Box) =>
      Math.min(W / (b.width * (1 + 2 * PAD)), H / (b.height * (1 + 2 * PAD)))
    const cards = (n: Node): Box => ({
      x: n.position.x,
      y: n.position.y,
      width: 240,
      height: 72,
    })
    const leaves = Array.from({ length: 12 }, (_, i) =>
      node(`leaf${i}`, (i - 6) * 300, 200)
    )
    const packed = Array.from({ length: 6000 }, (_, i) =>
      node(`lone${i}`, (i % 100) * 280 - 14000, 400 + Math.floor(i / 100) * 110)
    )
    const big = [node("core", 0, 0), ...leaves, ...packed]
    const wires = leaves.map((l) => edge("core", l.id))
    const all = big.map(cards).reduce((a, b) => ({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
      height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
    }))
    expect(zoomFor(all)).toBeLessThan(MIN_ZOOM)
    const got = openingPart(big, wires, cards, (b) => zoomFor(b) >= OPEN_ZOOM)
    expect(got.map((n) => n.id)).toContain("core")
    expect(got.length).toBeGreaterThan(3)
    expect(got.some((n) => n.id.startsWith("lone"))).toBe(false)
    const span = got.map(cards).reduce((a, b) => ({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
      height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
    }))
    expect(zoomFor(span)).toBeGreaterThanOrEqual(0.3)
  })
})
