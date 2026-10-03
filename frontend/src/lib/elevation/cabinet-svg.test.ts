// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { approxMeasure } from "@/lib/diagram/measure"
import { PRINT } from "@/lib/diagram/theme"

import { cabinet, devices, photos } from "./__fixtures__/cabinet"
import {
  expectSelfContained,
  parseSvg as parse,
  texts,
} from "./__fixtures__/expect"
import { CABINET_SVG, cabinetPhotoRequests, cabinetSvg } from "./cabinet-svg"
import type { CabinetSvgOptions } from "./cabinet-svg"

// The cabinet's plate as the SVG, PNG and PDF exports draw it: the golden
// files pin the drawing, and the cases below say what it must show.

const AT = "2026-10-02T09:30:00Z"
const opts = (o: CabinetSvgOptions = {}): CabinetSvgOptions => ({
  measure: approxMeasure,
  generatedAt: AT,
  photos,
  ...o,
})

const num = (el: Element | null | undefined, a: string) =>
  Number(el?.getAttribute(a))

/** Where the plate's top-left corner is drawn. */
function plateAt(doc: Document): { x: number; y: number } {
  const plate = doc.getElementById("cb-plate")!.getElementsByTagName("rect")[1]
  return { x: num(plate, "x"), y: num(plate, "y") }
}

const textOf = (doc: Document, s: string) =>
  [...doc.getElementsByTagName("text")].find((t) => t.textContent === s)

describe("cabinetSvg", () => {
  it("matches the golden file in Images, and is deterministic", async () => {
    const out = cabinetSvg(cabinet, devices, opts())
    expect(
      cabinetSvg(structuredClone(cabinet), structuredClone(devices), opts())
    ).toBe(out)
    expectSelfContained(out)
    await expect(out).toMatchFileSnapshot("./__golden__/cabinet-images.svg")
  })

  it("matches the golden file in Names", async () => {
    const out = cabinetSvg(cabinet, devices, opts({ look: "names" }))
    expectSelfContained(out)
    expect(out).not.toContain("<use")
    expect(out).not.toContain("<symbol")
    await expect(out).toMatchFileSnapshot("./__golden__/cabinet-names.svg")
  })

  it("draws the plate true to its millimetres, in its box", () => {
    const doc = parse(cabinetSvg(cabinet, devices, opts()))
    const [box, plate] = doc
      .getElementById("cb-plate")!
      .getElementsByTagName("rect")
    expect(num(plate, "width")).toBe(500 * CABINET_SVG.PX_PER_MM)
    expect(num(plate, "height")).toBe(600 * CABINET_SVG.PX_PER_MM)
    expect(num(box, "width")).toBe(560)
    expect(num(plate, "x") - num(box, "x")).toBe(30)
    expect(
      [...doc.getElementById("cb-heading")!.children].map((t) => t.textContent)
    ).toEqual([
      "K1",
      "Plant 1 · Hall B · Plate 500 × 600 mm · 2026-10-02 09:30 UTC",
    ])
  })

  it("puts each device on its rail at its offset", () => {
    const doc = parse(cabinetSvg(cabinet, devices, opts({ look: "names" })))
    const p = plateAt(doc)
    // sw-1: 100 mm along R1 (x 0), centred on its 100 mm centreline.
    const sw = textOf(doc, "sw-1")!.previousElementSibling!
    expect(num(sw, "x") - p.x).toBe(100)
    expect(num(sw, "y") - p.y).toBe(100 - 45)
    expect(num(sw, "width")).toBe(45)
    expect(sw.getAttribute("fill")).toBe("#2563eb")
    // Off every rail: not drawn.
    expect(textOf(doc, "loose")).toBeUndefined()
  })

  it("places a calibrated photo at its true size, cut to its device", () => {
    const doc = parse(cabinetSvg(cabinet, devices, opts()))
    const p = plateAt(doc)
    const uses = [...doc.getElementsByTagName("use")]
    expect(uses).toHaveLength(2)
    const [plc, sw] = uses
    // 100 mm wide (80 mm between guides at 0.1 and 0.9), its left guide on
    // the body's left edge, its rail line (0.45 of its 200 mm) on R1.
    expect(num(plc, "x") - p.x).toBe(-10)
    expect(num(plc, "width")).toBe(100)
    expect(num(plc, "height")).toBe(200)
    expect(num(plc, "y") - p.y).toBe(100 - 0.45 * 200)
    const clip = plc.getAttribute("clip-path")!.match(/#([^)]+)/)![1]
    const cut = doc.getElementById(clip)!.firstElementChild!
    expect([num(cut, "x") - p.x, num(cut, "y") - p.y]).toEqual([0, 50])
    expect([num(cut, "width"), num(cut, "height")]).toEqual([80, 120])
    // An uncalibrated photo is stretched over its body, and not cut.
    expect(sw.getAttribute("clip-path")).toBeNull()
    expect([num(sw, "x") - p.x, num(sw, "width"), num(sw, "height")]).toEqual([
      100, 45, 90,
    ])
    // One symbol per photo.
    expect(doc.querySelectorAll("symbol")).toHaveLength(2)
  })

  it("names a photo on a strip across its top, and runs a narrow module's name down it", () => {
    const doc = parse(cabinetSvg(cabinet, devices, opts()))
    const sw = textOf(doc, "sw-1")!
    expect(sw.getAttribute("transform")).toBeNull()
    expect(sw.previousElementSibling!.getAttribute("fill")).toBe(PRINT.tint)
    const mcb = textOf(doc, "mcb-1")!
    expect(mcb.getAttribute("transform")).toMatch(/^rotate\(90 /)
    // A light role: dark ink; a long name cut to the module's height.
    const relay = [...doc.getElementsByTagName("text")].find((t) =>
      t.textContent.startsWith("relay")
    )!
    expect(relay.textContent).toMatch(/…$/)
    expect(relay.getAttribute("fill")).toBe("#0a0a0a")
    // The PSU's photo would not load: its box in its role's colour.
    const psu = textOf(doc, "psu-1")!
    expect(psu.previousElementSibling!.getAttribute("fill")).toBe("#0f766e")
    expect(psu.getAttribute("fill")).toBe("#ffffff")
  })

  it("labels the rails where the page does", () => {
    const doc = parse(cabinetSvg(cabinet, devices, opts()))
    const p = plateAt(doc)
    const tags = doc.getElementById("cb-rail-tags")!
    expect(texts(tags)).toEqual(["R1", "R2", "R4", "R3"])
    const x = (s: string) => num(textOf(doc, s), "x") - p.x
    // R1: the first stretch its label fits, past the switch at 100-145.
    expect(x("R1")).toBeCloseTo(145 + 6, 6)
    expect(x("R2")).toBeCloseTo(20 + 36 + 6, 6)
    expect(x("R3")).toBeCloseTo(0 + 6, 6)
    // R4 is full: its label over its device, on a backdrop.
    expect(x("R4")).toBeCloseTo(300 + 6, 6)
    expect(tags.getElementsByTagName("rect")).toHaveLength(1)
    // Names and labels off.
    const bare = parse(
      cabinetSvg(
        cabinet,
        devices,
        opts({ look: "names", labels: false, railTags: false })
      )
    )
    expect(bare.getElementById("cb-rail-tags")).toBeNull()
    expect(texts(bare.getElementById("cb-devices")!)).toEqual([])
  })

  it("writes on a plate with no rails, and leaves the heading off the PDF's sheet", () => {
    const doc = parse(
      cabinetSvg({ ...cabinet, rails: [] }, [], {
        ...opts(),
        heading: false,
        emptyText: "No rails yet.",
      })
    )
    expect(doc.getElementById("cb-heading")).toBeNull()
    expect(texts(doc.getElementById("cb-plate")!)).toEqual(["No rails yet."])
  })

  it("asks for the photos it shows, at the width it draws them", () => {
    expect(cabinetPhotoRequests(cabinet, devices, { look: "names" })).toEqual(
      new Map()
    )
    expect(cabinetPhotoRequests(cabinet, devices)).toEqual(
      new Map([
        ["/media/device-type-images/plc.png", 100],
        ["/media/device-type-images/sw.png", 45],
        ["/media/device-type-images/psu.png", 60],
      ])
    )
  })
})
