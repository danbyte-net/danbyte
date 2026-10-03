// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { approxMeasure } from "@/lib/diagram/measure"
import { PRINT } from "@/lib/diagram/theme"

import {
  expectSelfContained,
  parseSvg as parse,
  texts,
} from "./__fixtures__/expect"
import { devices, photos, rack } from "./__fixtures__/rack"
import { RACK_SVG, rackPhotoRequests, rackSvg } from "./rack-svg"
import type { RackSvgOptions } from "./rack-svg"

// The rack's elevation as the SVG, PNG and PDF exports draw it: the golden
// files pin the drawing, and the cases below say what it must show.

const AT = "2026-10-02T09:30:00Z"
const opts = (o: RackSvgOptions = {}): RackSvgOptions => ({
  measure: approxMeasure,
  generatedAt: AT,
  ...o,
})

/** The block a device's name is written on: the shape before its text. */
function blockOf(group: Element, name: string): Element | null {
  const label = [...group.getElementsByTagName("text")].find(
    (t) => t.textContent === name
  )
  let el = label?.previousElementSibling ?? null
  while (el && el.nodeName !== "rect") el = el.previousElementSibling
  return el
}

const num = (el: Element | null, a: string) => Number(el?.getAttribute(a))

describe("rackSvg", () => {
  it("matches the golden file in Names, and is deterministic", async () => {
    const out = rackSvg(rack, devices, opts())
    expect(
      rackSvg(structuredClone(rack), structuredClone(devices), opts())
    ).toBe(out)
    expectSelfContained(out)
    await expect(out).toMatchFileSnapshot("./__golden__/rack-names.svg")
  })

  it("matches the golden file in Images, photos inlined", async () => {
    const o = opts({ look: "images", photos })
    const out = rackSvg(rack, devices, o)
    expect(rackSvg(rack, devices, o)).toBe(out)
    expectSelfContained(out)
    await expect(out).toMatchFileSnapshot("./__golden__/rack-images.svg")
  })

  it("draws the front and the rear side by side under their names", () => {
    const doc = parse(rackSvg(rack, devices, opts()))
    const front = doc.getElementById("rk-front")!
    const rear = doc.getElementById("rk-rear")!
    expect(texts(front)[0]).toBe("FRONT")
    expect(texts(rear)[0]).toBe("REAR")
    const frameX = (g: Element) => num(g.querySelector("rect"), "x")
    expect(frameX(rear)).toBeGreaterThan(frameX(front))
    // The heading: the rack's name and facts, dated.
    expect(texts(doc.getElementById("rk-heading")!)).toEqual([
      "R12",
      "AMS · Hall A · 19″ · 8 / 12 U · 2026-10-02 09:30 UTC",
    ])
    expect(doc.querySelector("title")!.textContent).toBe("R12 elevation")
  })

  it("numbers the units in the rack's own numbering", () => {
    const ruler = (r: typeof rack) =>
      texts(
        parse(rackSvg(r, [], opts({ faces: ["front"] }))).getElementById(
          "rk-front"
        )!
      ).slice(1)
    expect(ruler(rack)).toEqual([
      "12",
      "11",
      "10",
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
      "1",
    ])
    expect(
      ruler({ ...rack, u_height: 4, starting_unit: 7, desc_units: true })
    ).toEqual(["7", "8", "9", "10"])
  })

  it("places a device in its units, top down", () => {
    const doc = parse(rackSvg(rack, devices, opts()))
    const front = doc.getElementById("rk-front")!
    const units = texts(front).slice(1, 13)
    const rowY = (u: number) =>
      num(
        [...front.getElementsByTagName("text")][1 + units.indexOf(String(u))],
        "y"
      )
    // srv-01 at U8, 2U: from U9's row to U8's.
    const srv = blockOf(front, "srv-01")!
    const rowH = Math.round(44.45 * RACK_SVG.PX_PER_MM)
    expect(num(srv, "height")).toBe(2 * rowH - 1)
    expect(rowY(9)).toBeGreaterThan(num(srv, "y"))
    expect(rowY(8)).toBeLessThan(num(srv, "y") + 2 * rowH)
    expect(srv.getAttribute("fill")).toBe("#16a34a")
    // Its height at its right.
    expect(texts(front)).toContain("2U")
  })

  it("puts half-width devices side by side in one unit", () => {
    const front = parse(rackSvg(rack, devices, opts())).getElementById(
      "rk-front"
    )!
    const a = blockOf(front, "tor-a")!
    const bLabel = texts(front).find((t) => t.startsWith("tor-b"))!
    expect(bLabel).toMatch(/…$/)
    const b = blockOf(front, bLabel)!
    expect(num(a, "y")).toBe(num(b, "y"))
    expect(num(a, "width")).toBe(num(b, "width"))
    expect(num(b, "x")).toBeCloseTo(num(a, "x") + num(a, "width") + 1, 5)
  })

  it("hatches full-depth gear on the other face and leaves shallow gear off it", () => {
    const doc = parse(rackSvg(rack, devices, opts()))
    const front = doc.getElementById("rk-front")!
    const rear = doc.getElementById("rk-rear")!
    // Shallow: one face only.
    expect(texts(front)).toContain("patch-01")
    expect(texts(rear)).not.toContain("patch-01")
    expect(texts(rear)).toContain("ups-01")
    expect(texts(front)).not.toContain("ups-01")
    // Full depth: hatched, its name muted, on the face it isn't mounted on.
    const hatch = (g: Element) =>
      [...g.getElementsByTagName("path")].filter(
        (p) => p.getAttribute("stroke") === null
      )
    // core-sw-01, srv-01 and both half-width switches.
    expect(hatch(rear).length).toBe(4)
    expect(hatch(front).length).toBe(1) // rear-fan
    const muted = (g: Element, name: string) =>
      [...g.getElementsByTagName("text")]
        .find((t) => t.textContent === name)!
        .getAttribute("fill")
    expect(muted(front, "rear-fan")).toBe(PRINT.subtle)
    expect(muted(rear, "rear-fan")).not.toBe(PRINT.subtle)
    expect(muted(rear, "srv-01")).toBe(PRINT.subtle)
  })

  it("gives a device without a role the rack role's stripe", () => {
    const front = parse(rackSvg(rack, devices, opts())).getElementById(
      "rk-front"
    )!
    const label = [...front.getElementsByTagName("text")].find(
      (t) => t.textContent === "patch-01"
    )!
    const stripe = label.previousElementSibling!
    expect(stripe.getAttribute("fill")).toBe("#64748b")
    expect(stripe.getAttribute("width")).toBe("3")
  })

  it("draws 0U strips in their rail's lane, on their channel's face", () => {
    const doc = parse(rackSvg(rack, devices, opts()))
    const front = doc.getElementById("rk-front")!
    const rear = doc.getElementById("rk-rear")!
    expect(texts(front)).toContain("pdu-a")
    expect(texts(rear)).toContain("pdu-a")
    expect(texts(front)).not.toContain("pdu-b")
    expect(texts(rear)).toContain("pdu-b")
    const pdu = [...rear.getElementsByTagName("text")].find(
      (t) => t.textContent === "pdu-b"
    )!
    expect(pdu.getAttribute("transform")).toMatch(/^rotate\(90 /)
    // The rear has a lane each side, the front only the left: wider.
    const frameW = (g: Element) => num(g.querySelector("rect"), "width")
    expect(frameW(rear) - frameW(front)).toBe(
      RACK_SVG.LANE_W + RACK_SVG.LANE_GAP
    )
  })

  it("lays photos over their blocks, by reference, with name chips", () => {
    const svg = rackSvg(rack, devices, opts({ look: "images", photos }))
    const doc = parse(svg)
    const front = doc.getElementById("rk-front")!
    const uses = [...front.getElementsByTagName("use")]
    // core-sw-01, tor-a and tor-b; one symbol per photo.
    expect(uses.map((u) => u.getAttribute("href"))).toEqual([
      "#rk-ph0",
      "#rk-ph1",
      "#rk-ph1",
    ])
    expect(doc.querySelectorAll("symbol")).toHaveLength(2)
    expect(texts(front)).toContain("core-sw-01")
    // The server's photo would not load: its Names block.
    expect(blockOf(front, "srv-01")!.getAttribute("fill")).toBe("#16a34a")
    // Without labels, a photo carries no name.
    const bare = parse(
      rackSvg(rack, devices, opts({ look: "images", photos, labels: false }))
    ).getElementById("rk-front")!
    expect(texts(bare)).not.toContain("core-sw-01")
    expect(texts(bare)).toContain("srv-01")
  })

  it("draws one face alone, and no heading for the PDF's sheet", () => {
    const doc = parse(
      rackSvg(rack, devices, opts({ faces: ["rear"], heading: false }))
    )
    expect(doc.getElementById("rk-front")).toBeNull()
    expect(doc.getElementById("rk-heading")).toBeNull()
    expect(doc.getElementById("rk-rear")).not.toBeNull()
  })

  it("asks for the photos it shows, at the width it draws them", () => {
    expect(rackPhotoRequests(rack, devices)).toEqual(new Map())
    const asked = rackPhotoRequests(rack, devices, { look: "images" })
    const full = Math.round(482.6 * RACK_SVG.PX_PER_MM)
    expect(asked).toEqual(
      new Map([
        ["/media/device-type-images/switch.png", full],
        ["/media/device-type-images/server.png", full],
        ["/media/device-type-images/half.png", full / 2],
      ])
    )
  })
})
