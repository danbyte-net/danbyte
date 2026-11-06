// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fabric } from "@/lib/diagram/__fixtures__/fabric"
import { drawingDevices, pdfDrawing } from "@/lib/diagram/pdf-drawing"
import type * as Drawing from "@/lib/diagram/pdf-drawing"
import { ExportMenu, reportDrawing } from "./export-menu"
import type { ReportDrawing } from "./export-menu"

// The topology report's diagram and Export ▸ PDF are one drawing: both go
// through lib/diagram/pdf-drawing.ts with the same document and the same
// legend choice, so a change to the PDF drawing changes both.

vi.mock("@/lib/diagram/pdf-drawing", async (load) => {
  const real = await load<typeof Drawing>()
  return { ...real, pdfDrawing: vi.fn(real.pdfDrawing) }
})
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const drawn = vi.mocked(pdfDrawing)

beforeEach(() => {
  localStorage.clear()
  drawn.mockClear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function open() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /export/i }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
}

describe("the report's drawing is the Export's PDF drawing", () => {
  it("draws through the same function with the same inputs", async () => {
    const posted: Record<string, unknown>[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      posted.push(JSON.parse(String(init?.body ?? "{}")))
      return Promise.resolve(
        new Response(JSON.stringify({ url: "/x/abcdefghijklmnopqrstuvwx/" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    let draw: (() => Promise<ReportDrawing | null>) | null = null
    render(
      <ExportMenu
        document={() => fabric}
        name="DC1 fabric"
        onReport={(d) => {
          draw = d
        }}
      />
    )
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "PDF" }))
    await waitFor(() => expect(posted).toHaveLength(1))
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: /PDF report/ }))
    expect(draw).not.toBeNull()
    const report = await draw!()
    expect(drawn).toHaveBeenCalledTimes(2)
    const [exportCall, reportCall] = drawn.mock.calls
    expect(reportCall[0]).toEqual(exportCall[0])
    expect(reportCall[1]).toBe(exportCall[1])
    expect(reportCall[2].legend).toBe(exportCall[2].legend)
    // The same SVG reaches both servers' sheets.
    expect(report?.drawing.svg).toBe(posted[0].svg)
    expect(report?.drawing.title).toBe(posted[0].title)
    expect(report?.titleBlock).toBe(posted[0].title_block)
  })

  it("reportDrawing names the devices the drawing shows", async () => {
    const got = await reportDrawing(async () => fabric, "Fabric", false)
    expect(got?.devices).toEqual(drawingDevices(fabric))
    expect(got?.titleBlock).toBe(false)
    expect(await reportDrawing(async () => null, "x", true)).toBeNull()
  })
})

describe("drawingDevices", () => {
  it("reads a card's device from its id or its link", () => {
    const id = "0b5c6a52-1d1e-4a4c-9a0e-2f5a9c3d1e01"
    const other = "1b5c6a52-1d1e-4a4c-9a0e-2f5a9c3d1e02"
    const doc = {
      ...fabric,
      nodes: [
        { ...fabric.nodes[0], id: `dev:${id}` },
        {
          ...fabric.nodes[0],
          id: "chassis:x",
          link: `https://d.example/devices/${other}`,
        },
        { ...fabric.nodes[0], id: "site:y", link: undefined },
      ],
    }
    expect(drawingDevices(doc)).toEqual([id, other])
  })
})
