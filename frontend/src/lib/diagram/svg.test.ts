// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { fabric } from "./__fixtures__/fabric"
import { toSvg } from "./svg"
import { bandPaint, PRINT } from "./theme"
import type { DiagramDocument } from "./types"

const clone = (d: DiagramDocument): DiagramDocument => structuredClone(d)

function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0)
  return doc
}

describe("the fabric fixture", () => {
  it("links reference existing nodes and nubs", () => {
    const nodes = new Map(fabric.nodes.map((n) => [n.id, n]))
    for (const l of fabric.links)
      for (const end of [l.source, l.target]) {
        const n = nodes.get(end.node)
        expect(n, `${l.id} → ${end.node}`).toBeDefined()
        if (end.nub !== undefined) expect(n!.nubs?.[end.nub]).toBeDefined()
      }
  })

  it("ids are unique across the document", () => {
    const ids = [
      ...fabric.nodes.map((n) => n.id),
      ...fabric.links.map((l) => l.id),
      ...fabric.bands.map((b) => b.id),
      ...fabric.notes.map((n) => n.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("covers every line kind and link meaning", () => {
    expect(new Set(fabric.links.map((l) => l.kind))).toEqual(
      new Set(["straight", "elbow", "bendy", "cyclical"])
    )
    expect(new Set(fabric.links.map((l) => l.sem))).toEqual(
      new Set(["cable", "bundle", "ghost", "bgp"])
    )
    expect(fabric.bands.some((b) => b.orient === "v")).toBe(true)
  })
})

describe("toSvg", () => {
  it("matches the golden file and is deterministic", async () => {
    const out = toSvg(fabric)
    expect(toSvg(clone(fabric))).toBe(out)
    await expect(out).toMatchFileSnapshot("./__golden__/fabric.svg")
  })

  it("matches the golden file with the title block, legend and links", async () => {
    const opts = { titleBlock: true, legend: true, links: true }
    const out = toSvg(fabric, opts)
    expect(toSvg(clone(fabric), opts)).toBe(out)
    await expect(out).toMatchFileSnapshot("./__golden__/fabric-sheet.svg")
  })

  it("is well-formed SVG with one path per link", () => {
    const doc = parse(toSvg(fabric))
    const root = doc.documentElement
    expect(root.nodeName).toBe("svg")
    const b = fabric.bounds
    expect(root.getAttribute("viewBox")).toBe(
      `${b.x - 24} ${b.y - 24} ${b.w + 48} ${b.h + 48}`
    )
    expect(doc.getElementById("links")!.children).toHaveLength(
      fabric.links.length
    )
    expect(doc.getElementById("nodes")!.children).toHaveLength(
      fabric.nodes.length
    )
  })

  it("titles rows over the lines and under the cards; turns side labels", () => {
    const doc = parse(toSvg(fabric))
    const groups = [...doc.documentElement.children].map((g) => g.id)
    const at = (id: string) => groups.indexOf(id)
    expect(at("band-titles")).toBeGreaterThan(at("links"))
    expect(at("band-titles")).toBeLessThan(at("nodes"))
    const texts = [
      ...doc.getElementById("band-titles")!.getElementsByTagName("text"),
    ]
    expect(texts.map((t) => t.textContent)).toEqual(["Spine", "Leaf", "Access"])
    // Centred on the row, over a chip of the row's own colour.
    const spine = fabric.bands.find((k) => k.id === "band-spine")!
    expect(Number(texts[0].getAttribute("x"))).toBeCloseTo(
      spine.x + spine.w / 2
    )
    expect(texts[0].getAttribute("text-anchor")).toBe("middle")
    expect(texts[0].previousElementSibling!.getAttribute("fill")).toBe(
      bandPaint(spine).fill
    )
    // The side band's label is on the band, reading bottom to top.
    const wan = [
      ...doc.getElementById("bands")!.getElementsByTagName("text"),
    ].find((t) => t.textContent === "WAN")!
    expect(wan.getAttribute("transform")).toMatch(/^rotate\(-90 /)
  })

  it("escapes names and labels", () => {
    const out = toSvg(fabric)
    expect(out).toContain(">a&lt;b&amp;&quot;c</text>")
    expect(out).toContain(">S/N &gt;x&apos;</text>")
    expect(out).toContain(">Lab &amp; &lt;test&gt;</text>")
    expect(out).not.toContain('a<b&"c')
    const texts = [...parse(out).getElementsByTagName("text")].map(
      (t) => t.textContent
    )
    expect(texts).toContain('a<b&"c')
  })

  it("stays inside the print-safe subset", () => {
    const out = toSvg(fabric)
    for (const banned of [
      "foreignObject",
      " style=",
      "var(",
      "<a ",
      "<style",
      "opacity",
      "filter",
      "dominant-baseline",
      "textLength",
      "class=",
    ])
      expect(out, banned).not.toContain(banned)
    // Colours are solid hex only.
    for (const m of out.matchAll(/(?:fill|stroke)="([^"]*)"/g))
      expect(m[1]).toMatch(/^(#[0-9a-f]{6}|none)$/)
  })

  it("links back to Danbyte only when asked, and only to web URLs", () => {
    expect(toSvg(fabric, { links: true })).toContain(
      '<a href="https://danbyte.example/devices/spine-01">'
    )
    const doc = clone(fabric)
    doc.nodes[0].link = "javascript:alert(1)"
    doc.links[0].link = "//evil.example/x"
    const out = toSvg(doc, { links: true })
    expect(out).not.toContain("javascript:")
    expect(out).not.toContain("evil.example")
  })

  it("draws a photo from a refused source as its card", () => {
    const doc = clone(fabric)
    const photo = doc.nodes.find((n) => n.kind === "photo")!
    photo.photo!.href = "javascript:alert(1)"
    const out = toSvg(doc)
    expect(out).not.toContain("javascript:")
    expect(out).not.toContain("<use ")
    expect(out).toContain(
      `<rect x="60.5" y="560.5" width="239" height="55" rx="9.5" fill="${photo.fill}"`
    )
  })

  it("embeds fonts only when asked, and only as data: URIs", () => {
    const src = "data:font/woff2;base64,d09GMgABAAAAAA=="
    const out = toSvg(fabric, {
      embedFont: [
        {
          family: "Inter",
          src,
          weight: "100 900",
          unicodeRange: "U+0000-00FF",
        },
        { family: "Evil", src: "https://example.com/x.woff2" },
      ],
    })
    expect(out).toContain(
      `<style>@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;src:url(${src}) format("woff2");unicode-range:U+0000-00FF}</style>`
    )
    expect(out).not.toContain("example.com")
    expect(out).not.toContain("Evil")
  })

  it("never lets a colour or dash escape its attribute", () => {
    const doc = clone(fabric)
    doc.nodes[0].fill = 'red" onload="x'
    doc.nodes[0].ink = "url(#x)"
    doc.links[0].stroke = "var(--primary)"
    doc.links[0].dash = "1;2"
    const out = toSvg(doc)
    expect(out).not.toContain("onload")
    expect(out).not.toContain("url(")
    expect(out).not.toContain("1;2")
    expect(out).toContain(`fill="${PRINT.wash}"`)
  })

  it("draws a transparent page on request", () => {
    const b = fabric.bounds
    const page = `<rect x="${b.x - 24}" y="${b.y - 24}"`
    expect(toSvg(fabric)).toContain(page)
    expect(toSvg(fabric, { background: null })).not.toContain(page)
  })

  it("defines each distinct photo once", () => {
    const doc = clone(fabric)
    const photo = doc.nodes.find((n) => n.kind === "photo")!
    doc.nodes.push({ ...structuredClone(photo), id: "dev:patch-b", x: 400 })
    const out = toSvg(doc)
    expect(out.match(/<symbol /g)).toHaveLength(1)
    expect(out.match(/<use /g)).toHaveLength(2)
  })

  it("grows the page to fit the title block under a small drawing", () => {
    const tiny: DiagramDocument = {
      ...clone(fabric),
      bands: [],
      links: [],
      notes: [],
      nodes: [clone(fabric).nodes[0]],
      bounds: { x: 200, y: 30, w: 160, h: 70 },
    }
    const root = parse(toSvg(tiny, { titleBlock: true })).documentElement
    expect(Number(root.getAttribute("width"))).toBeGreaterThan(160 + 48)
    expect(Number(root.getAttribute("height"))).toBeGreaterThan(70 + 48)
  })
})
