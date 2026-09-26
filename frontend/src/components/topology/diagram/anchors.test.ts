import { describe, expect, it } from "vitest"

import { anchorLinks, anchorPoint, chooseSides, sideLength } from "./anchors"
import type { AnchorLink } from "./anchors"
import { NUB } from "./card-layout"
import type { Anchor, Rect, Side } from "./types"

// Link ends leave through the side facing the other end. Simple meets at
// the side's midpoint; Detailed gives each cabled interface its own nub,
// ordered so the lines leaving a side never cross.

const box = (x: number, y: number, w = 120, h = 60): Rect => ({ x, y, w, h })

type Seg = [number, number, number, number]

/** Proper crossing of two segments (shared endpoints do not count). */
function crosses([a, b, c, d]: Seg, [e, f, g, h]: Seg): boolean {
  const o = (
    px: number,
    py: number,
    qx: number,
    qy: number,
    rx: number,
    ry: number
  ) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
  return (
    o(a, b, c, d, e, f) * o(a, b, c, d, g, h) < 0 &&
    o(e, f, g, h, a, b) * o(e, f, g, h, c, d) < 0
  )
}

/** Straight segments from nub tip to nub tip for every cable. */
function segments(
  boxes: Map<string, Rect>,
  links: AnchorLink[],
  res: ReturnType<typeof anchorLinks>
): Seg[] {
  const out: Seg[] = []
  for (const l of links) {
    const a = res.links.get(l.id)!
    a.a.forEach((an, i) => {
      const p = anchorPoint(boxes.get(l.source)!, an, NUB.OUT)
      const q = anchorPoint(boxes.get(l.target)!, a.b[i], NUB.OUT)
      out.push([p.x, p.y, q.x, q.y])
    })
  }
  return out
}

function noCrossings(segs: Seg[]) {
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++)
      expect(crosses(segs[i], segs[j]), `segments ${i} and ${j}`).toBe(false)
}

const sideOf = (a: Anchor): Side => {
  if (a.k !== "side") throw new Error("expected a side anchor")
  return a.side
}
const offOf = (a: Anchor): number => {
  if (a.k !== "side") throw new Error("expected a side anchor")
  return a.off
}

describe("chooseSides", () => {
  it("connects up and down between rows", () => {
    expect(chooseSides(box(0, 0), box(40, 200))).toEqual(["B", "T"])
    expect(chooseSides(box(40, 200), box(0, 0))).toEqual(["T", "B"])
  })

  it("connects sideways within a row", () => {
    expect(chooseSides(box(0, 0), box(300, 20))).toEqual(["R", "L"])
    expect(chooseSides(box(300, 20), box(0, 0))).toEqual(["L", "R"])
  })

  it("counts both boxes' extents, so a wide card connects vertically", () => {
    const spine = box(0, 0, 600, 40)
    const leaf = box(560, 120, 100, 40)
    expect(chooseSides(spine, leaf)).toEqual(["B", "T"])
  })

  it("answers the same from either end", () => {
    const a = box(0, 0)
    for (const b of [box(90, 70), box(-200, 40), box(10, -300)]) {
      const [sa, sb] = chooseSides(a, b)
      expect(chooseSides(b, a)).toEqual([sb, sa])
    }
  })
})

describe("anchorLinks: Simple", () => {
  it("meets every line on a side at its midpoint", () => {
    const boxes = new Map([
      ["hub", box(0, 0, 200, 60)],
      ["l1", box(-200, 200)],
      ["l2", box(300, 200)],
    ])
    const links: AnchorLink[] = [
      {
        id: "e1",
        source: "hub",
        target: "l1",
        cables: [{ a: "et1" }, { a: "et2" }],
      },
      { id: "e2", source: "hub", target: "l2" },
    ]
    const r = anchorLinks(boxes, links, "simple")
    for (const id of ["e1", "e2"]) {
      const a = r.links.get(id)!
      expect(a.a).toHaveLength(1)
      expect(a.a[0]).toMatchObject({ k: "side", side: "B", off: 100 })
      expect(a.b[0]).toMatchObject({ k: "side", side: "T", off: 60 })
    }
    expect(r.links.get("e1")!.a[0]).toMatchObject({ port: "et1" })
    expect(r.nubs.size).toBe(0)
    expect(r.demand.size).toBe(0)
  })

  it("skips links whose cards are not placed", () => {
    const r = anchorLinks(
      new Map([["a", box(0, 0)]]),
      [{ id: "x", source: "a", target: "gone" }],
      "simple"
    )
    expect(r.links.size).toBe(0)
  })
})

describe("anchorLinks: Detailed", () => {
  const fan = () => {
    const boxes = new Map<string, Rect>([["hub", box(0, 0, 400, 60)]])
    const links: AnchorLink[] = []
    // Leaves at different distances, deliberately out of x order by id.
    const at: [number, number][] = [
      [-300, 400],
      [-150, 120],
      [150, 300],
      [420, 140],
      [60, 500],
    ]
    at.forEach(([x, y], i) => {
      boxes.set(`leaf${i}`, box(x, y))
      links.push({
        id: `e${i}`,
        source: "hub",
        target: `leaf${i}`,
        cables: [{ a: `et-0/0/${i}`, b: "et-0/0/48" }],
      })
    })
    return { boxes, links }
  }

  it("gives each cable its own nub at full pitch, centred on the side", () => {
    const { boxes, links } = fan()
    const r = anchorLinks(boxes, links, "detailed")
    const nubs = r.nubs.get("hub")!
    expect(nubs.map((n) => n.side)).toEqual(["B", "B", "B", "B", "B"])
    const offs = nubs.map((n) => n.off)
    for (let i = 1; i < offs.length; i++)
      expect(offs[i] - offs[i - 1]).toBe(NUB.PITCH)
    expect((offs[0] + offs[offs.length - 1]) / 2).toBe(200)
    expect(r.demand.get("hub")).toEqual({ T: 0, R: 0, B: 5, L: 0 })
    expect(r.demand.get("leaf0")).toEqual({ T: 1, R: 0, B: 0, L: 0 })
  })

  it("orders a side by where the far ends are, so nothing crosses", () => {
    const { boxes, links } = fan()
    const r = anchorLinks(boxes, links, "detailed")
    noCrossings(segments(boxes, links, r))
  })

  it("keeps a bundle untwisted between two cards", () => {
    const boxes = new Map([
      ["a", box(0, 0, 300, 60)],
      ["b", box(80, 240, 300, 60)],
      ["c", box(500, 60, 120, 60)],
    ])
    const links: AnchorLink[] = [
      {
        id: "ab",
        source: "a",
        target: "b",
        cables: [
          { a: "Gi1/0/10", b: "Te1" },
          { a: "Gi1/0/2", b: "Te2" },
          { a: "Gi1/0/1", b: "Te3" },
        ],
      },
      // The same pair again, oriented the other way.
      {
        id: "ba",
        source: "b",
        target: "a",
        cables: [{ a: "Te4", b: "Gi1/0/3" }],
      },
      { id: "ac", source: "a", target: "c", cables: [{ a: "Gi1/0/48" }] },
    ]
    const r = anchorLinks(boxes, links, "detailed")
    noCrossings(segments(boxes, links, r))
    // Natural port order along a's bottom side, one pair order at both ends.
    const aBottom = r.nubs
      .get("a")!
      .filter((n) => n.side === "B")
      .map((n) => n.port)
    expect(aBottom).toEqual(["Gi1/0/1", "Gi1/0/2", "Gi1/0/3", "Gi1/0/10"])
  })

  it("turns a bundle round a corner without crossing", () => {
    // a's right side to b's top side: the top cable at a is the outer one.
    const boxes = new Map([
      ["a", box(0, 0, 120, 120)],
      ["b", box(300, 300, 120, 60)],
    ])
    const links: AnchorLink[] = [
      {
        id: "ab",
        source: "a",
        target: "b",
        cables: [{ a: "p1" }, { a: "p2" }, { a: "p3" }],
        force: { a: "R", b: "T" },
      },
    ]
    const r = anchorLinks(boxes, links, "detailed")
    const { a, b } = r.links.get("ab")!
    expect(a.map(sideOf)).toEqual(["R", "R", "R"])
    expect(b.map(sideOf)).toEqual(["T", "T", "T"])
    // Higher on a's right side ↔ further right on b's top side.
    const aOff = a.map(offOf)
    const bOff = b.map(offOf)
    const byA = [0, 1, 2].sort((i, j) => aOff[i] - aOff[j])
    const byB = [0, 1, 2].sort((i, j) => bOff[j] - bOff[i])
    expect(byA).toEqual(byB)
    noCrossings(segments(boxes, links, r))
  })

  it("nests a bundle that leaves and arrives on the same facing", () => {
    // Both ends on their bottom sides (an arc underneath): the outermost
    // nub at a pairs with the outermost at b.
    const boxes = new Map([
      ["a", box(0, 0)],
      ["b", box(400, 0)],
    ])
    const links: AnchorLink[] = [
      {
        id: "ab",
        source: "a",
        target: "b",
        cables: [{ a: "p1" }, { a: "p2" }],
        force: { a: "B", b: "B" },
      },
    ]
    const { a, b } = anchorLinks(boxes, links, "detailed").links.get("ab")!
    const outerA = offOf(a[0]) < offOf(a[1]) ? 0 : 1
    const outerB = offOf(b[0]) > offOf(b[1]) ? 0 : 1
    expect(outerA).toBe(outerB)
  })

  it("closes up the pitch on a side too short for it", () => {
    const boxes = new Map([
      ["a", box(0, 0, 60, 40)],
      ["b", box(0, 300, 60, 40)],
    ])
    const cables = Array.from({ length: 6 }, (_, i) => ({
      a: `p${i}`,
      b: `q${i}`,
    }))
    const r = anchorLinks(
      boxes,
      [{ id: "ab", source: "a", target: "b", cables }],
      "detailed"
    )
    const offs = r.links
      .get("ab")!
      .a.map(offOf)
      .sort((x, y) => x - y)
    const edge = NUB.INSET + NUB.ALONG / 2
    expect(offs[0]).toBeCloseTo(edge)
    expect(offs[offs.length - 1]).toBeCloseTo(60 - edge)
    expect(offs[1] - offs[0]).toBeLessThan(NUB.PITCH)
  })

  it("wraps past the per-side cap onto the adjacent sides, in order", () => {
    const boxes = new Map<string, Rect>([["hub", box(0, 0, 1200, 60)]])
    const links: AnchorLink[] = []
    for (let i = 0; i < 60; i++) {
      const id = String(i).padStart(2, "0")
      boxes.set(`s${id}`, box(-900 + i * 50, 600, 40, 40))
      links.push({
        id: `e${id}`,
        source: "hub",
        target: `s${id}`,
        cables: [{ a: `p${i}` }],
      })
    }
    const r = anchorLinks(boxes, links, "detailed")
    expect(r.demand.get("hub")).toEqual({ T: 0, R: 6, B: 48, L: 6 })
    const side = (i: number) =>
      sideOf(r.links.get(`e${String(i).padStart(2, "0")}`)!.a[0])
    const off = (i: number) =>
      offOf(r.links.get(`e${String(i).padStart(2, "0")}`)!.a[0])
    // The six leftmost continue round the bottom-left corner up the left
    // side, the six rightmost up the right side; the one nearest the
    // bottom side sits nearest the corner.
    for (let i = 0; i < 6; i++) expect(side(i)).toBe("L")
    for (let i = 6; i < 54; i++) expect(side(i)).toBe("B")
    for (let i = 54; i < 60; i++) expect(side(i)).toBe("R")
    for (let i = 1; i < 6; i++) expect(off(i)).toBeGreaterThan(off(i - 1))
    for (let i = 55; i < 60; i++) expect(off(i)).toBeLessThan(off(i - 1))
    for (let i = 7; i < 54; i++) expect(off(i)).toBeGreaterThan(off(i - 1))
  })

  it("keeps pinned sides and midpoints for links without nubs", () => {
    const boxes = new Map([
      ["a", box(0, 0)],
      ["b", box(0, 300)],
    ])
    const links: AnchorLink[] = [
      { id: "cable", source: "a", target: "b", cables: [{ a: "p1" }] },
      { id: "bgp", source: "a", target: "b", simple: true },
    ]
    const r = anchorLinks(boxes, links, "detailed", {
      sides: new Map([["cable", ["R", "R"] as [Side, Side]]]),
    })
    expect(r.links.get("cable")!.a[0]).toMatchObject({ side: "R" })
    expect(r.links.get("bgp")!.a[0]).toMatchObject({
      side: "B",
      off: sideLength(boxes.get("a")!, "B") / 2,
    })
    expect(r.nubs.get("a")).toHaveLength(1)
  })

  it("is deterministic", () => {
    const { boxes, links } = fan()
    expect(anchorLinks(boxes, links, "detailed")).toEqual(
      anchorLinks(boxes, links, "detailed")
    )
  })
})

describe("anchorPoint", () => {
  it("resolves a side offset, moved out along the normal", () => {
    const b = box(10, 20, 100, 50)
    expect(anchorPoint(b, { k: "side", side: "B", off: 30 })).toEqual({
      x: 40,
      y: 70,
      dir: [0, 1],
    })
    expect(anchorPoint(b, { k: "side", side: "L", off: 5 }, 6)).toEqual({
      x: 4,
      y: 25,
      dir: [-1, 0],
    })
  })

  it("resolves a photo marker", () => {
    const b = box(0, 0, 480, 44)
    expect(
      anchorPoint(b, { k: "point", fx: 0.25, fy: 0.5, exit: "T", port: "1" })
    ).toEqual({ x: 120, y: 22, dir: [0, -1] })
  })
})
