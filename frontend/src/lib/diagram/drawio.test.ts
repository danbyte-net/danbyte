// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { fabric } from "./__fixtures__/fabric"
import { fabricSimple } from "./__fixtures__/fabric-simple"
import { drawioPointAt, toDrawio, toDrawioSvg } from "./drawio"
import { linkLabels, polylineLength } from "./geometry"
import type { LabelBlock } from "./geometry"
import { LABEL, PRINT } from "./theme"
import type { DiagramDocument, DiagramLink, Pt, Rect } from "./types"

const clone = (d: DiagramDocument): DiagramDocument => structuredClone(d)

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0)
  return doc
}

interface Cell {
  id: string
  /** The <object> wrapper, or the <mxCell> itself. */
  holder: Element
  cell: Element
  parent: string | null
  style: Record<string, string>
  value: string
}

function parseStyle(s: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (s ?? "").split(";").filter(Boolean)) {
    const i = part.indexOf("=")
    if (i < 0) out[part] = ""
    else out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

/** A page's cells by id, in file order. */
function cells(diagram: Element): Map<string, Cell> {
  const out = new Map<string, Cell>()
  for (const cell of Array.from(diagram.getElementsByTagName("mxCell"))) {
    const wrapped = cell.parentElement?.tagName === "object"
    const holder = wrapped ? cell.parentElement : cell
    const id = holder.getAttribute("id") ?? ""
    expect(out.has(id), `duplicate id ${id}`).toBe(false)
    out.set(id, {
      id,
      holder,
      cell,
      parent: cell.getAttribute("parent"),
      style: parseStyle(cell.getAttribute("style")),
      value: holder.getAttribute(wrapped ? "label" : "value") ?? "",
    })
  }
  return out
}

function pages(xml: string): Map<string, Cell>[] {
  return Array.from(parse(xml).getElementsByTagName("diagram")).map(cells)
}

const geo = (c: Cell) => c.cell.getElementsByTagName("mxGeometry")[0]
const num = (e: Element, a: string) => Number(e.getAttribute(a) ?? 0)

/** A vertex's box on the page: its geometry plus its container's corner. */
function absBox(page: Map<string, Cell>, id: string): Rect {
  const c = page.get(id)!
  const g = geo(c)
  const r = {
    x: num(g, "x"),
    y: num(g, "y"),
    w: num(g, "width"),
    h: num(g, "height"),
  }
  const p = c.parent ? page.get(c.parent) : undefined
  if (p && p.parent !== "0" && p.parent !== null) {
    const o = absBox(page, p.id)
    return { ...r, x: r.x + o.x, y: r.y + o.y }
  }
  return r
}

/** How the file places the doc: bounds' corner at (40, 40). */
const shiftOf = (d: DiagramDocument): Pt => ({
  x: 40 - d.bounds.x,
  y: 40 - d.bounds.y,
})

/** An edge's end on the page, from its terminal cell and constraint. */
function endPoint(page: Map<string, Cell>, e: Cell, source: boolean): Pt {
  const term = e.cell.getAttribute(source ? "source" : "target")!
  const b = absBox(page, term)
  const fx = Number(e.style[source ? "exitX" : "entryX"])
  const fy = Number(e.style[source ? "exitY" : "entryY"])
  return { x: b.x + fx * b.w, y: b.y + fy * b.h }
}

/** An edge's route on the page: ends, then its waypoints. */
function route(page: Map<string, Cell>, e: Cell): Pt[] {
  const arr = geo(e).getElementsByTagName("Array").item(0)
  const pts = arr
    ? Array.from(arr.getElementsByTagName("mxPoint")).map((p) => ({
        x: num(p, "x"),
        y: num(p, "y"),
      }))
    : []
  return [endPoint(page, e, true), ...pts, endPoint(page, e, false)]
}

/** Where a relative geometry puts a label: draw.io's point plus offset. */
function labelPoint(poly: Pt[], g: Element): Pt {
  const q = drawioPointAt(poly, num(g, "x"))
  const off = Array.from(g.getElementsByTagName("mxPoint")).find(
    (p) => p.getAttribute("as") === "offset"
  )
  return {
    x: q.x + (off ? num(off, "x") : 0),
    y: q.y + (off ? num(off, "y") : 0),
  }
}

function centre(b: LabelBlock): Pt {
  const c = { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 }
  if (!b.rotate) return c
  const r = (b.rotate * Math.PI) / 180
  return {
    x: b.ox + (c.x - b.ox) * Math.cos(r) - (c.y - b.oy) * Math.sin(r),
    y: b.oy + (c.x - b.ox) * Math.sin(r) + (c.y - b.oy) * Math.cos(r),
  }
}

const near = (p: Pt, q: Pt, tol: number) =>
  Math.hypot(p.x - q.x, p.y - q.y) <= tol

/** Point lists equal to the file's 0.01 px. */
function expectPts(got: Pt[], want: Pt[]) {
  expect(got).toHaveLength(want.length)
  got.forEach((p, i) =>
    expect(near(p, want[i], 0.006), `point ${i}`).toBe(true)
  )
}

const SIMPLE = () => toDrawio([fabricSimple])
const DETAILED = () => toDrawio([fabric], { mode: "detailed" })

describe("toDrawio", () => {
  it("matches the golden files and is deterministic", async () => {
    const simple = SIMPLE()
    expect(toDrawio([clone(fabricSimple)])).toBe(simple)
    await expect(simple).toMatchFileSnapshot("./__golden__/fabric.drawio")
    const detailed = DETAILED()
    expect(toDrawio([clone(fabric)], { mode: "detailed" })).toBe(detailed)
    await expect(detailed).toMatchFileSnapshot(
      "./__golden__/fabric-detailed.drawio"
    )
  })

  it("is well-formed, ids are unique and every reference resolves", () => {
    for (const xml of [
      SIMPLE(),
      DETAILED(),
      toDrawio([fabric, fabricSimple], { mode: "detailed" }),
    ])
      for (const page of pages(xml)) {
        expect(page.get("0")?.parent).toBeNull()
        expect(page.get("1")?.parent).toBe("0")
        for (const c of page.values()) {
          if (c.id === "0") continue
          expect(page.has(c.parent ?? ""), `${c.id} parent`).toBe(true)
          for (const a of ["source", "target"]) {
            const ref = c.cell.getAttribute(a)
            if (ref) expect(page.has(ref), `${c.id} ${a} ${ref}`).toBe(true)
          }
        }
      }
  })

  it("writes the lines under the cards, as the canvas and the SVG draw them", () => {
    for (const xml of [SIMPLE(), DETAILED()]) {
      const page = pages(xml)[0]
      const order = [...page.values()]
      const top = order.filter((c) => c.parent === "1")
      const edges = top.filter((c) => c.cell.getAttribute("edge") === "1")
      const cards = top.filter(
        (c) =>
          c.cell.getAttribute("vertex") === "1" &&
          c.holder.getAttribute("danbyte_id")?.startsWith("dev:")
      )
      expect(edges.length).toBeGreaterThan(0)
      expect(cards.length).toBeGreaterThan(0)
      const last = Math.max(...edges.map((e) => order.indexOf(e)))
      const firstCard = Math.min(...cards.map((c) => order.indexOf(c)))
      expect(last).toBeLessThan(firstCard)
    }
    // Still the same file every time.
    expect(DETAILED()).toBe(DETAILED())
  })

  it("puts every card where the document has it, nested in its band", () => {
    for (const [xml, doc] of [
      [SIMPLE(), fabricSimple],
      [DETAILED(), fabric],
    ] as const) {
      const page = pages(xml)[0]
      const s = shiftOf(doc)
      for (const n of doc.nodes) {
        const b = absBox(page, n.id)
        expect(b).toEqual({ x: n.x + s.x, y: n.y + s.y, w: n.w, h: n.h })
      }
    }
    const page = pages(SIMPLE())[0]
    expect(page.get("dev:spine-01")?.parent).toBe("band-spine")
    expect(page.get("dev:leaf-01")?.parent).toBe("band-leaf")
    expect(page.get("dev:srv-01")?.parent).toBe("band-access")
    expect(page.get("dev:patch-a")?.parent).toBe("zone-lab")
    // A side band is drawn behind, not a parent: a card has one parent.
    expect(page.get("dev:fw-01")?.parent).toBe("1")
    // Relative to the row's corner.
    const g = geo(page.get("dev:leaf-01")!)
    expect([num(g, "x"), num(g, "y")]).toEqual([60, 30])
  })

  it("draws row bands as swimlanes and side bands behind them", () => {
    const page = pages(SIMPLE())[0]
    const row = page.get("band-spine")!
    expect(row.style).toMatchObject({
      swimlane: "",
      horizontal: "0",
      startSize: "28",
    })
    expect(row.style.container).toBeUndefined()
    const side = page.get("band-wan")!
    expect(side.style).toMatchObject({ container: "0", dropTarget: "0" })
    expect(page.get("zone-lab")!.style.container).toBe("1")
    // Background shapes come first, so rows never hide under them.
    const order = [...page.keys()]
    expect(order.indexOf("band-wan")).toBeLessThan(order.indexOf("band-spine"))
  })

  it("nests a zone in the row that holds it", () => {
    const doc: DiagramDocument = {
      ...clone(fabricSimple),
      bands: [
        {
          id: "row",
          kind: "row",
          orient: "h",
          label: "Row",
          x: 0,
          y: 0,
          w: 600,
          h: 300,
        },
        {
          id: "zone",
          kind: "zone",
          orient: "h",
          label: "Zone",
          x: 100,
          y: 50,
          w: 300,
          h: 200,
        },
      ],
      nodes: [{ ...fabricSimple.nodes[0], x: 150, y: 100 }],
      links: [],
      notes: [],
    }
    const page = pages(toDrawio([doc]))[0]
    expect(page.get("zone")?.parent).toBe("row")
    expect(page.get(doc.nodes[0].id)?.parent).toBe("zone")
    const g = geo(page.get(doc.nodes[0].id)!)
    expect([num(g, "x"), num(g, "y")]).toEqual([50, 50])
    const order = [...page.keys()]
    expect(order.indexOf("row")).toBeLessThan(order.indexOf("zone"))
    expect(order.indexOf("zone")).toBeLessThan(order.indexOf(doc.nodes[0].id))
  })

  it("attaches Simple lines at the side midpoints, perimeter off", () => {
    const page = pages(SIMPLE())[0]
    const s = shiftOf(fabricSimple)
    expect([...page.keys()].some((id) => id.includes("-nub-"))).toBe(false)
    for (const l of fabricSimple.links) {
      const e = page.get(l.id)!
      expect(e.style).toMatchObject({ exitPerimeter: "0", entryPerimeter: "0" })
      for (const [end, source] of [
        [l.source, true],
        [l.target, false],
      ] as const) {
        const f = [
          Number(e.style[source ? "exitX" : "entryX"]),
          Number(e.style[source ? "exitY" : "entryY"]),
        ]
        expect(f.includes(0.5) && f.some((v) => v === 0 || v === 1)).toBe(true)
        expect(
          near(
            endPoint(page, e, source),
            { x: end.x + s.x, y: end.y + s.y },
            0.01
          )
        ).toBe(true)
      }
    }
  })

  it("puts Detailed nubs on the card and each line on its own nub", () => {
    const page = pages(DETAILED())[0]
    const s = shiftOf(fabric)
    const nubs = fabric.nodes.reduce((k, n) => k + (n.nubs?.length ?? 0), 0)
    const nubCells = [...page.values()].filter((c) => c.id.includes("-nub-"))
    expect(nubCells).toHaveLength(nubs)
    expect(page.get("dev:spine-01-nub-0")?.parent).toBe("dev:spine-01")
    expect(page.get("dev:spine-01-nub-0")?.holder.getAttribute("tooltip")).toBe(
      "Ethernet1/1"
    )
    for (const l of fabric.links) {
      const e = page.get(l.id)!
      if (l.source.nub !== undefined)
        expect(e.cell.getAttribute("source")).toBe(
          `${l.source.node}-nub-${l.source.nub}`
        )
      for (const [end, source] of [
        [l.source, true],
        [l.target, false],
      ] as const) {
        // A photo marker moves out to the card edge (photos draw as cards).
        if (end.node === "dev:patch-a") continue
        expect(
          near(
            endPoint(page, e, source),
            { x: end.x + s.x, y: end.y + s.y },
            0.01
          )
        ).toBe(true)
      }
    }
  })

  it("turns port names along their line", () => {
    const page = pages(DETAILED())[0]
    const l = fabric.links.find((k) => k.id === "cab-2")!
    for (const b of linkLabels(l)) {
      if (b.role === "mid") continue
      const rot = Number(page.get(`cab-2-${b.role}`)!.style.rotation)
      expect(rot).toBeCloseTo((b.rotate + 360) % 360, 1)
    }
  })

  it("draws a Detailed document in Simple without nubs, lines on the card", () => {
    const page = pages(toDrawio([fabric]))[0]
    expect([...page.keys()].some((id) => id.includes("-nub-"))).toBe(false)
    const e = page.get("cab-1")!
    expect(e.cell.getAttribute("source")).toBe("dev:spine-01")
    // The nub's place along the side, on the card's own edge.
    expect(e.style).toMatchObject({ exitX: "0.3125", exitY: "1" })
  })

  it("routes each line kind the way draw.io draws it", () => {
    const page = pages(SIMPLE())[0]
    const s = shiftOf(fabricSimple)
    const shifted = (l: DiagramLink) =>
      l.points.map((p) => ({ x: p.x + s.x, y: p.y + s.y }))
    const inner = (id: string) => route(page, page.get(id)!).slice(1, -1)
    const by = (id: string) => fabricSimple.links.find((l) => l.id === id)!

    expect(page.get("cab-1")!.style).toMatchObject({
      edgeStyle: "none",
      rounded: "0",
    })
    expect(inner("cab-1")).toEqual([])
    // Elbows: every corner a waypoint for the orthogonal router, which
    // reproduces them and keeps them square when a card moves.
    expect(page.get("cab-2")!.style).toMatchObject({
      edgeStyle: "orthogonalEdgeStyle",
      rounded: "1",
      arcSize: "12",
    })
    expectPts(inner("cab-2"), shifted(by("cab-2")))
    // Curves: draw.io's curved rule through the same control points.
    for (const id of ["cab-3", "cab-4"]) {
      expect(page.get(id)!.style).toMatchObject({
        edgeStyle: "none",
        curved: "1",
      })
      expectPts(inner(id), shifted(by(id)))
    }
  })

  it("drops elbow points on a straight run, and writes a slanted elbow as is", () => {
    const base = fabricSimple.links.find((l) => l.id === "cab-2")!
    const [c1, c2] = base.points
    const straightRun: DiagramLink = {
      ...base,
      id: "run",
      points: [{ x: base.source.x, y: (base.source.y + c1.y) / 2 }, c1, c2],
    }
    const slanted: DiagramLink = {
      ...base,
      id: "slant",
      points: [{ x: c1.x + 20, y: c1.y }, c2],
    }
    const doc = { ...clone(fabricSimple), links: [straightRun, slanted] }
    const page = pages(toDrawio([doc]))[0]
    const s = shiftOf(doc)
    expectPts(
      route(page, page.get("run")!).slice(1, -1),
      [c1, c2].map((p) => ({ x: p.x + s.x, y: p.y + s.y }))
    )
    expect(page.get("slant")!.style).toMatchObject({
      edgeStyle: "none",
      rounded: "1",
      arcSize: "12",
    })
    expectPts(
      route(page, page.get("slant")!).slice(1, -1),
      slanted.points.map((p) => ({ x: p.x + s.x, y: p.y + s.y }))
    )
  })

  it("places end labels at x = 2t-1 along the line, on it", () => {
    const page = pages(SIMPLE())[0]
    const l = fabricSimple.links.find((k) => k.id === "cab-5")!
    const len = polylineLength([l.source, l.target])
    const [a, b] = linkLabels(l).filter((k) => k.role !== "mid")
    // A lead out from each end, then half the label's gap and text.
    const t = (LABEL.LEAD + a.box.w / 2) / len
    const u = (LABEL.LEAD + b.box.w / 2) / len
    const x = (id: string) => num(geo(page.get(id)!), "x")
    expect(x("cab-5-a")).toBeCloseTo(2 * t - 1, 3)
    expect(x("cab-5-b")).toBeCloseTo(1 - 2 * u, 3)
    // On the line, over the page's colour.
    const cell = page.get("cab-5-a")!
    expect(cell.style.labelBackgroundColor).toBe("#ffffff")
  })

  it("lands every label where the screen puts it", () => {
    for (const [xml, doc] of [
      [SIMPLE(), fabricSimple],
      [DETAILED(), fabric],
    ] as const) {
      const page = pages(xml)[0]
      const s = shiftOf(doc)
      for (const l of doc.links) {
        if (l.source.node === "dev:patch-a") continue
        const e = page.get(l.id)!
        const poly = route(page, e)
        for (const b of linkLabels(l)) {
          const g =
            b.role === "mid"
              ? geo(e)
              : geo(page.get(`${l.id}-${b.role}${b.index ?? ""}`)!)
          const want = centre(b)
          expect(
            near(labelPoint(poly, g), { x: want.x + s.x, y: want.y + s.y }, 1),
            `${l.id} ${b.role}`
          ).toBe(true)
        }
      }
    }
  })

  it("follows mxGraph's rule for a point along an edge", () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]
    expect(drawioPointAt(poly, 0)).toEqual({ x: 75, y: 0 })
    expect(drawioPointAt(poly, -1)).toEqual({ x: 0, y: 0 })
    expect(drawioPointAt(poly, 1)).toEqual({ x: 100, y: 50 })
    // The distance is rounded to whole pixels, as draw.io does.
    expect(drawioPointAt(poly, 2 * (110.4 / 150) - 1)).toEqual({
      x: 100,
      y: 10,
    })
  })

  it("keeps the middle label on the line itself", () => {
    const page = pages(SIMPLE())[0]
    expect(page.get("lag-po10")!.value).toBe("<b>2x Po10</b><br>10.1.0.8/31")
    expect(page.get("cab-5")!.value).toBe("10.0.2.0/24")
    expect(page.get("ghost-1")!.style.fontStyle).toBe("2")
  })

  it("escapes user text twice in HTML labels", () => {
    const xml = SIMPLE()
    expect(xml).toContain("a&amp;lt;b&amp;amp;&amp;quot;c")
    const page = pages(xml)[0]
    const label = page.get("dev:srv-01")!.value
    expect(label).toContain("a&lt;b&amp;&quot;c")
    const html = new DOMParser().parseFromString(label, "text/html")
    expect(html.body.textContent).toContain('a<b&"c')
    expect(html.body.textContent).toContain("S/N >x'")
    expect(page.get("zone-lab")!.value).toBe("Lab &amp; &lt;test&gt;")
  })

  it("writes dashed lines with fixDash, LLDP and BGP on layers of their own", () => {
    const page = pages(SIMPLE())[0]
    expect(page.get("cab-4")!.style).toMatchObject({
      dashed: "1",
      fixDash: "1",
      dashPattern: "10 4",
    })
    expect(page.get("cab-1")!.style.dashed).toBeUndefined()
    expect(page.get("layer-lldp")).toMatchObject({
      parent: "0",
      value: "Discovered (LLDP)",
    })
    expect(page.get("layer-bgp")).toMatchObject({
      parent: "0",
      value: "BGP sessions",
    })
    expect(page.get("ghost-1")!.parent).toBe("layer-lldp")
    expect(page.get("ghost-1")!.style.dashPattern).toBe("6 4")
    expect(page.get("bgp-1")!.parent).toBe("layer-bgp")
    expect(page.get("cab-1")!.parent).toBe("1")

    const cablesOnly = {
      ...clone(fabricSimple),
      links: fabricSimple.links.filter((l) => l.sem === "cable"),
    }
    const plain = pages(toDrawio([cablesOnly]))[0]
    expect(plain.has("layer-lldp") || plain.has("layer-bgp")).toBe(false)
  })

  it("wraps cards in objects that link back to Danbyte", () => {
    const page = pages(SIMPLE())[0]
    const spine = page.get("dev:spine-01")!
    expect(spine.holder.tagName).toBe("object")
    expect(spine.holder.getAttribute("danbyte_id")).toBe("dev:spine-01")
    expect(spine.holder.getAttribute("link")).toBe(
      "https://danbyte.example/devices/spine-01"
    )
    expect(spine.style).toMatchObject({
      rounded: "1",
      fillColor: "#6366f1",
      fontColor: "#ffffff",
      fontFamily: "Helvetica",
    })
    expect(page.get("dev:unknown-01")!.holder.hasAttribute("link")).toBe(false)
    expect(page.get("dev:unknown-01")!.style.fillColor).toBe(PRINT.wash)
    // A name cut to fit keeps its full text as the hover tooltip.
    const leaf4 = page.get("dev:leaf-04")!
    expect(leaf4.value).toContain("…")
    expect(leaf4.holder.getAttribute("tooltip")).toBe(fabric.nodes[5].title)
  })

  it("puts the pill in the card's top-left corner", () => {
    const page = pages(SIMPLE())[0]
    const pill = page.get("dev:spine-02-pill")!
    expect(pill.parent).toBe("dev:spine-02")
    expect(pill.value).toBe("Planned")
    expect([num(geo(pill), "x"), num(geo(pill), "y")]).toEqual([6, 6])
    // A name too long to centre beside the pill: the pill takes a row.
    expect(page.get("dev:leaf-04")!.style.spacingTop).toBe("24")
    expect(page.get("dev:spine-01")!.style.spacingTop).toBe("6")
  })

  it("keeps unsafe input out of styles and links", () => {
    const doc = clone(fabricSimple)
    const n = doc.nodes[0]
    n.link = "javascript:alert(1)"
    n.fill = "red;shape=image"
    n.title = "one\ntwo\u0007"
    doc.nodes[1].link = "//evil.example/x"
    const l = doc.links[0]
    l.dash = "4;shape=image"
    l.stroke = "#fff;x=1"
    l.link = "data:text/html,x"
    const xml = toDrawio([doc])
    expect(xml).not.toContain("javascript:")
    expect(xml).not.toContain("evil.example")
    expect(xml).not.toContain("\u0007")
    const page = pages(xml)[0]
    const card = page.get(n.id)!
    expect(card.style.fillColor).toBe(PRINT.wash)
    expect(card.style.shape).toBeUndefined()
    expect(card.value).toContain("one<br>two")
    const e = page.get(l.id)!
    expect(e.style.dashPattern).toBeUndefined()
    expect(e.style.shape).toBeUndefined()
    expect(e.style.strokeColor).toBe(PRINT.subtle)
    expect(e.holder.hasAttribute("link")).toBe(false)
  })

  it("writes a line whose node is missing from its point", () => {
    const doc = clone(fabricSimple)
    doc.links[0].target.node = "dev:gone"
    const page = pages(toDrawio([doc]))[0]
    const e = page.get(doc.links[0].id)!
    expect(e.cell.hasAttribute("target")).toBe(false)
    expect(e.style.entryX).toBeUndefined()
    const tp = Array.from(geo(e).getElementsByTagName("mxPoint")).find(
      (p) => p.getAttribute("as") === "targetPoint"
    )!
    const s = shiftOf(doc)
    expect([num(tp, "x"), num(tp, "y")]).toEqual([
      doc.links[0].target.x + s.x,
      doc.links[0].target.y + s.y,
    ])
  })

  it("writes notes as text, with the Lucide icon beside them", () => {
    const page = pages(SIMPLE())[0]
    const note = page.get("note-internet")!
    expect(note.value).toBe("Internet")
    expect(note.style).toMatchObject({ text: "", align: "left" })
    expect(page.get("note-rack")!.value).toBe("Rack A12<br>row 3")
    const icon = page.get("note-internet-icon")!
    expect(icon.parent).toBe("note-internet")
    const image = /^data:image\/svg\+xml,(.+)$/.exec(icon.style.image)!
    expect(atob(image[1])).toContain('d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79')
  })

  it("writes a page per document", () => {
    const docs = parse(
      toDrawio([
        fabricSimple,
        { ...fabric, meta: { ...fabric.meta, title: "Two" } },
      ])
    )
    const diagrams = Array.from(docs.getElementsByTagName("diagram"))
    expect(diagrams.map((d) => d.getAttribute("id"))).toEqual([
      "page-1",
      "page-2",
    ])
    expect(diagrams.map((d) => d.getAttribute("name"))).toEqual([
      "DC1 fabric",
      "Two",
    ])
    const empty = parse(toDrawio([])).getElementsByTagName("diagram")
    expect(empty).toHaveLength(1)
  })
})

describe("toDrawioSvg", () => {
  it("embeds the draw.io file in an SVG of the same drawing", () => {
    for (const [doc, mode] of [
      [fabricSimple, "simple"],
      [fabric, "detailed"],
    ] as const) {
      const out = toDrawioSvg(doc, { mode })
      expect(toDrawioSvg(clone(doc), { mode })).toBe(out)
      const svg = new DOMParser().parseFromString(out, "image/svg+xml")
      expect(svg.getElementsByTagName("parsererror")).toHaveLength(0)
      const root = svg.documentElement
      expect(root.nodeName).toBe("svg")
      expect(root.getAttribute("content")).toBe(toDrawio([doc], { mode }))
      // Nubs show only where the file has them.
      expect(out.includes(`fill="${PRINT.faint}"`)).toBe(mode === "detailed")
    }
  })

  it("draws a Detailed document in Simple as the file holds it", () => {
    const out = toDrawioSvg(fabric)
    expect(out).not.toContain(`fill="${PRINT.faint}"`)
    const svg = new DOMParser().parseFromString(out, "image/svg+xml")
    expect(svg.documentElement.getAttribute("content")).toBe(toDrawio([fabric]))
  })
})
