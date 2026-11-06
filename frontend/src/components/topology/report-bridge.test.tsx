// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { REPORT_MESSAGE, ReportBridge, drawSavedView } from "./report-bridge"
import type { ReportDrawing } from "./export/export-menu"

// A bulk topology report draws each saved view in the real map page, off
// screen: the frame posts the map's Export ▸ PDF drawing once it settles.

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

const drawing = (svg = "<svg/>"): ReportDrawing => ({
  drawing: { svg, title: "DC1", filters: "" },
  devices: ["d1"],
  titleBlock: true,
})

describe("ReportBridge", () => {
  it("posts the drawing once the map holds still", async () => {
    vi.useFakeTimers()
    const post = vi.spyOn(window.parent, "postMessage")
    let n = 0
    // The layout settles after the second look.
    const draw = vi.fn(async () => drawing(n++ < 2 ? `<svg ${n}/>` : "<svg/>"))
    render(<ReportBridge view="v1" ready draw={draw} />)
    for (let i = 0; i < 8 && !post.mock.calls.length; i++)
      await vi.advanceTimersByTimeAsync(400)
    expect(post).toHaveBeenCalledTimes(1)
    const [msg, origin] = post.mock.calls[0] as unknown as [unknown, string]
    expect(origin).toBe(window.location.origin)
    expect(msg).toMatchObject({
      type: REPORT_MESSAGE,
      view: "v1",
      drawing: { drawing: { svg: "<svg/>" } },
    })
  })

  it("waits for the map", async () => {
    vi.useFakeTimers()
    const draw = vi.fn(async () => drawing())
    render(<ReportBridge view="v1" ready={false} draw={draw} />)
    await vi.advanceTimersByTimeAsync(2000)
    expect(draw).not.toHaveBeenCalled()
  })
})

describe("drawSavedView", () => {
  it("opens the view's map off screen and answers its message", async () => {
    const p = drawSavedView("v 1")
    const frame = document.querySelector(
      "iframe[data-part=report-frame]"
    ) as HTMLIFrameElement
    expect(frame.getAttribute("src")).toBe("/topology/map?view=v%201&report=1")
    // Another window's, another origin's and another view's messages are
    // not this view's.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        source: frame.contentWindow,
        data: { type: REPORT_MESSAGE, view: "v 1", drawing: drawing("<x/>") },
      })
    )
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: REPORT_MESSAGE, view: "v 1", drawing: drawing() },
      })
    )
    const got = await p
    expect(got.drawing.svg).toBe("<svg/>")
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("fails when the view does not draw", async () => {
    vi.useFakeTimers()
    const p = drawSavedView("v1", 1000)
    const caught = p.catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await caught).toMatch(/did not finish/)
    expect(document.querySelector("iframe")).toBeNull()
  })
})
