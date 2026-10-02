// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { downloadPng, withSvgPaint } from "./png-export"

// The rack's and the cabinet's PNG: html-to-image over the theme's page
// colour, at twice the pixels, downloaded under the name it is given - with
// an SVG's class-given paint written onto its parts while the snapshot is
// taken, since html-to-image copies an <svg> without the stylesheet.

const { toPng, errorToast } = vi.hoisted(() => ({
  toPng: vi.fn<(el: HTMLElement, opts: object) => Promise<string>>(),
  errorToast: vi.fn(),
}))
vi.mock("html-to-image", () => ({ toPng }))
vi.mock("sonner", () => ({ toast: { error: errorToast } }))

let clicked: HTMLAnchorElement[] = []
beforeEach(() => {
  toPng.mockReset()
  toPng.mockResolvedValue("data:image/png;base64,AAAA")
  errorToast.mockReset()
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.classList.remove("dark")
  document.body.innerHTML = ""
  document.head.innerHTML = ""
})

describe("downloadPng", () => {
  it("snapshots the element and downloads it under its name", async () => {
    const el = document.createElement("div")
    await downloadPng(el, "K1-plate.png")
    expect(toPng).toHaveBeenCalledWith(el, {
      backgroundColor: "#ffffff",
      pixelRatio: 2,
      style: { margin: "0" },
    })
    expect(clicked).toHaveLength(1)
    expect(clicked[0].download).toBe("K1-plate.png")
    expect(clicked[0].href).toBe("data:image/png;base64,AAAA")
  })

  it("keeps a dark page dark", async () => {
    document.documentElement.classList.add("dark")
    await downloadPng(document.createElement("div"), "x.png")
    expect(toPng.mock.calls[0][1]).toMatchObject({
      backgroundColor: "#09090b",
    })
  })

  it("says so when the snapshot fails", async () => {
    toPng.mockRejectedValue(new Error("tainted"))
    await downloadPng(document.createElement("div"), "x.png")
    expect(clicked).toHaveLength(0)
    expect(errorToast).toHaveBeenCalledWith("Couldn't make the PNG")
  })
})

describe("withSvgPaint", () => {
  it("writes an SVG part's class-given paint into its style for the snapshot, then takes it out", async () => {
    const style = document.createElement("style")
    style.textContent = ".plate { fill: rgb(1, 2, 3); stroke: rgb(4, 5, 6) }"
    document.head.append(style)
    document.body.innerHTML = `
      <div id="drawing">
        <svg><rect class="plate"></rect><rect id="own" style="fill: rgb(9, 9, 9)"></rect></svg>
      </div>`
    const plate = document.querySelector<SVGElement>(".plate")!
    const own = document.querySelector<SVGElement>("#own")!
    let during = { plate: "", stroke: "", own: "" }
    await withSvgPaint(document.getElementById("drawing")!, async () => {
      during = {
        plate: plate.style.fill,
        stroke: plate.style.stroke,
        own: own.style.fill,
      }
    })
    expect(during).toEqual({
      plate: "rgb(1, 2, 3)",
      stroke: "rgb(4, 5, 6)",
      own: "rgb(9, 9, 9)",
    })
    // Afterwards: the class paints again, and a part's own style is as it was.
    expect(plate.getAttribute("style") ?? "").toBe("")
    expect(own.style.fill).toBe("rgb(9, 9, 9)")
  })
})
