import { describe, expect, it } from "vitest"

import { fabric } from "./__fixtures__/fabric"
import {
  along,
  cardText,
  curvedPath,
  documentBounds,
  fmt,
  labelCorners,
  linkLabels,
  linkPath,
  inlinePlace,
  inlineSpan,
  PORT_H,
  routePoints,
  routePolyline,
  uprightAngle,
} from "./geometry"
import { measureText } from "./measure"
import { LABEL } from "./theme"
import type { DiagramLink, Pt } from "./types"

const link = (id: string): DiagramLink => {
  const l = fabric.links.find((x) => x.id === id)
  if (!l) throw new Error(id)
  return l
}
const node = (id: string) => {
  const n = fabric.nodes.find((x) => x.id === id)
  if (!n) throw new Error(id)
  return n
}

/** mxGraph's `mxConnector.prototype.paintCurvedLine`, transcribed onto a
 * recording canvas - the reference the curved rule must reproduce. */
function mxPaintCurvedLine(pts: Pt[]): string {
  const cmds: string[] = []
  const c = {
    moveTo: (x: number, y: number) => cmds.push(`M ${fmt(x)},${fmt(y)}`),
    quadTo: (x1: number, y1: number, x2: number, y2: number) =>
      cmds.push(`Q ${fmt(x1)},${fmt(y1)} ${fmt(x2)},${fmt(y2)}`),
  }
  const pt = pts[0]
  const n = pts.length
  c.moveTo(pt.x, pt.y)
  for (let i = 1; i < n - 2; i++) {
    const p0 = pts[i]
    const p1 = pts[i + 1]
    c.quadTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2)
  }
  const p0 = pts[n - 2]
  const p1 = pts[n - 1]
  c.quadTo(p0.x, p0.y, p1.x, p1.y)
  return cmds.join(" ")
}

describe("fmt", () => {
  it("rounds to 0.01 px without -0 or NaN", () => {
    expect(fmt(1.256)).toBe("1.26")
    expect(fmt(-0.004)).toBe("0")
    expect(fmt(12)).toBe("12")
    expect(fmt(Number.NaN)).toBe("0")
    expect(fmt(Infinity)).toBe("0")
  })
})

describe("link paths", () => {
  it("bendy and cyclical follow mxGraph's curved rule", () => {
    for (const id of ["cab-3", "cab-4"]) {
      const l = link(id)
      expect(linkPath(l)).toBe(mxPaintCurvedLine(routePoints(l)))
    }
    const many = [
      { x: 0, y: 0 },
      { x: 40, y: 80 },
      { x: 120, y: -20 },
      { x: 200, y: 60 },
      { x: 260, y: 0 },
    ]
    expect(curvedPath(many)).toBe(mxPaintCurvedLine(many))
    // One control point: a single quadratic.
    expect(curvedPath(many.slice(0, 3))).toBe("M 0,0 Q 40,80 120,-20")
  })

  it("a cyclical arc passes through the midpoint of its control points", () => {
    const l = link("cab-4")
    const apex = {
      x: (l.points[0].x + l.points[1].x) / 2,
      y: (l.points[0].y + l.points[1].y) / 2,
    }
    const poly = routePolyline(l)
    expect(
      poly.some((p) => Math.hypot(p.x - apex.x, p.y - apex.y) < 1e-6)
    ).toBe(true)
  })

  it("elbow routes are axis-aligned and rounded at every corner", () => {
    for (const l of fabric.links.filter((x) => x.kind === "elbow")) {
      const pts = routePoints(l)
      for (let i = 1; i < pts.length; i++)
        expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(
          true
        )
      expect(linkPath(l).match(/ Q /g)?.length).toBe(pts.length - 2)
    }
  })

  it("straight lines are plain polylines", () => {
    expect(linkPath(link("cab-1"))).toMatch(/^M [\d.]+,[\d.]+ L [\d.]+,[\d.]+$/)
  })
})

describe("along", () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 20 },
  ]
  it("walks the route from either end with the outward direction", () => {
    expect(along(poly, 5)).toEqual({ x: 5, y: 0, angle: 0 })
    expect(along(poly, 15)).toEqual({ x: 10, y: 5, angle: 90 })
    expect(along(poly, 5, true)).toEqual({ x: 10, y: 15, angle: -90 })
  })
  it("clamps past the end", () => {
    expect(along(poly, 99)).toMatchObject({ x: 10, y: 20 })
  })
})

describe("link labels", () => {
  it("end labels sit on the line, upright, a lead out from the end", () => {
    let n = 0
    for (const l of fabric.links) {
      const poly = routePolyline(l)
      for (const end of ["a", "b"] as const) {
        const blocks = linkLabels(l).filter(
          (x) => x.role === end || x.role === `ip${end}`
        )
        if (!blocks.length) continue
        let ahead = LABEL.LEAD
        for (const b of blocks) {
          // Upright: never past 10° beyond vertical either way.
          expect(b.rotate).toBeGreaterThanOrEqual(-100)
          expect(b.rotate).toBeLessThan(80)
          expect(b.anchor).toBe("middle")
          expect(b.chip).toBe(false)
          // Centred on the line, turned with it; the line breaks for the
          // text and a gap either side, one label after another.
          const at = along(poly, ahead + b.box.w / 2, end === "b")
          expect(b.ox).toBeCloseTo(at.x, 5)
          expect(b.oy).toBeCloseTo(at.y, 5)
          expect(b.rotate).toBeCloseTo(uprightAngle(at.angle), 5)
          expect(b.box.h).toBe(PORT_H)
          ahead += b.box.w + LABEL.LEAD
          n++
        }
      }
    }
    expect(n).toBeGreaterThan(5)
  })

  it("places end labels where the builder put them", () => {
    const l = link("cab-1")
    const at = { x: 12, y: 34, rotate: -90 }
    const ip = { x: 12, y: 90, rotate: -90 }
    const blocks = linkLabels({
      ...l,
      labels: {
        a: { text: "Ethernet1/1", at },
        aIps: [{ text: "10.0.0.1", at: ip }],
      },
    })
    const b = blocks.find((x) => x.role === "a")!
    expect([b.ox, b.oy, b.rotate]).toEqual([12, 34, -90])
    expect(b.box.x + b.box.w / 2).toBeCloseTo(12, 5)
    expect(b.box.y + b.box.h / 2).toBeCloseTo(34, 5)
    expect(b.box.w).toBeCloseTo(
      inlineSpan(measureText("Ethernet1/1", LABEL.END_SIZE, 400)),
      5
    )
    const a = blocks.find((x) => x.role === "ipa")!
    expect([a.ox, a.oy, a.index]).toEqual([12, 90, 0])
  })

  it("turns an end label by one rule at any angle", () => {
    // 0° and 180° read left to right; anything within 10° of vertical,
    // either way along the line, reads upwards.
    const cases: [number, number][] = [
      [0, 0],
      [75, 75],
      [85, -95],
      [90, -90],
      [-90, -90],
      [95, -85],
      [180, 0],
    ]
    for (const [angle, want] of cases) {
      expect(uprightAngle(angle)).toBeCloseTo(want, 9)
      const p = inlinePlace({ x: 0, y: 0 }, angle, 40)
      expect(p.rotate).toBeCloseTo(want, 9)
      // On the line, whichever way it runs.
      const r = (angle * Math.PI) / 180
      expect(p.x * Math.sin(r) - p.y * Math.cos(r)).toBeCloseTo(0, 9)
    }
  })

  it("middle labels stack at the middle of the route", () => {
    const m = linkLabels(link("lag-po10")).find((b) => b.role === "mid")!
    expect(m.lines.map((l) => l.text)).toEqual(["2x Po10", "10.1.0.8/31"])
    expect(m.lines[0].weight).toBe(600)
    const ghost = linkLabels(link("ghost-1"))[0]
    expect(ghost.lines[0].italic).toBe(true)
  })

  it("rotated boxes turn about their origin", () => {
    const b = linkLabels(link("cab-2")).find((x) => x.role === "b")!
    const c = labelCorners(b)
    // Vertical run: the box is taller than wide once turned.
    const w = Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x))
    const h = Math.max(...c.map((p) => p.y)) - Math.min(...c.map((p) => p.y))
    expect(h).toBeGreaterThan(w)
  })
})

describe("cardText", () => {
  it("keeps the name clear of the pill, beside it or under it", () => {
    let stacked = 0
    for (const n of fabric.nodes.filter((x) => x.pill && x.kind === "card")) {
      const t = cardText(n)
      const pill = t.pill!
      const w = measureText(t.title.text, 12, 700)
      expect(t.title.x + w / 2).toBeLessThanOrEqual(n.x + n.w)
      if (t.title.y - 12 >= pill.y + pill.h) stacked++
      else expect(t.title.x - w / 2).toBeGreaterThanOrEqual(pill.x + pill.w)
    }
    expect(stacked).toBe(1)
  })

  it("centres a name that fits and cuts one that does not", () => {
    const leaf1 = node("dev:leaf-01")
    expect(cardText(leaf1).title).toMatchObject({
      text: "leaf-01",
      x: leaf1.x + leaf1.w / 2,
    })
    const leaf4 = cardText(node("dev:leaf-04"))
    expect(leaf4.title.text.endsWith("…")).toBe(true)
    expect(leaf4.pill!.text.endsWith("…")).toBe(true)
  })

  it("draws the canvas layout as given when the builder sends one", () => {
    const n = {
      ...node("dev:leaf-02"),
      title: "leaf-02-cut…",
      place: {
        title: { x: 380, y: 219 },
        lines: [{ x: 375, y: 234 }],
        pill: { x: 306, y: 206, w: 38, h: 16 },
      },
    }
    expect(cardText(n)).toEqual({
      pill: { x: 306, y: 206, w: 38, h: 16, text: "Down" },
      title: { text: "leaf-02-cut…", x: 380, y: 219 },
      // A line without a position is not drawn.
      lines: [{ text: "10.0.1.2", x: 375, y: 234 }],
    })
  })

  it("puts a photo's caption under the image", () => {
    const n = node("dev:patch-a")
    const t = cardText(n)
    expect(t.title.y).toBeGreaterThan(n.photo!.y + n.photo!.h)
    expect(t.lines[0].y).toBeLessThanOrEqual(n.y + n.h)
  })
})

describe("documentBounds", () => {
  it("holds every band, card, nub, route point and label", () => {
    const b = documentBounds(fabric)
    const inside = (p: Pt) =>
      p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h
    for (const n of fabric.nodes) {
      expect(inside(n)).toBe(true)
      for (const nub of n.nubs ?? [])
        expect(inside({ x: nub.x + nub.w, y: nub.y + nub.h })).toBe(true)
    }
    for (const l of fabric.links) {
      routePolyline(l).forEach((p) => expect(inside(p)).toBe(true))
      linkLabels(l)
        .flatMap(labelCorners)
        .forEach((p) => expect(inside(p)).toBe(true))
    }
    expect(fabric.bounds).toEqual(b)
  })
})
