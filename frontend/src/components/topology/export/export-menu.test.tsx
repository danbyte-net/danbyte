// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DRAWIO_MIME } from "@/lib/diagram/drawio"
import { fabric } from "@/lib/diagram/__fixtures__/fabric"
import { downloadBlob } from "@/lib/table-export"
import { ExportMenu, exportFileName } from "./export-menu"

// The one Export menu: each entry writes its file from the map's document,
// and the area and draw.io mode choices reach the document builder.

vi.mock("@/lib/table-export", () => ({ downloadBlob: vi.fn() }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const download = vi.mocked(downloadBlob)

beforeEach(() => {
  localStorage.clear()
  download.mockClear()
})
afterEach(cleanup)

function open() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /export/i }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
}

const today = exportFileName("DC1 fabric", "x").slice(0, -2)

describe("ExportMenu", () => {
  it("writes an SVG of the whole map", async () => {
    const doc = vi.fn(() => fabric)
    render(<ExportMenu document={doc} name="DC1 fabric" modes />)
    open()
    fireEvent.click(await screen.findByText("SVG"))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    const [file, mime, body] = download.mock.calls[0]
    expect(file).toBe(`${today}.svg`)
    expect(mime).toBe("image/svg+xml")
    expect(String(body)).toMatch(/^<svg /)
    expect(doc).toHaveBeenCalledWith({ area: "all", mode: undefined })
  })

  it("passes the area and the draw.io mode to the document", async () => {
    const doc = vi.fn(() => ({
      ...fabric,
      meta: { ...fabric.meta, mode: "detailed" as const },
    }))
    render(<ExportMenu document={doc} name="DC1 fabric" modes />)
    open()
    fireEvent.click(await screen.findByText("Visible area"))
    fireEvent.click(await screen.findByText("Detailed"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "draw.io" }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(doc).toHaveBeenCalledWith({ area: "visible", mode: "detailed" })
    const [file, mime, body] = download.mock.calls[0]
    expect(file).toBe(`${today}.drawio`)
    expect(mime).toBe(DRAWIO_MIME)
    expect(String(body)).toMatch(/^<mxfile /)
    // The choices are remembered.
    expect(JSON.parse(localStorage.getItem("topology:export")!)).toMatchObject({
      area: "visible",
      drawio: "detailed",
    })
  })

  it("draws photos into draw.io only when asked, inlined", async () => {
    const photo: typeof fabric = {
      ...fabric,
      nodes: fabric.nodes.map((n, i) =>
        i === 0
          ? {
              ...n,
              kind: "photo" as const,
              photo: {
                href: "/media/device-type-images/a.png",
                x: n.x,
                y: n.y,
                w: n.w,
                h: n.h / 2,
                markers: [],
              },
            }
          : n
      ),
    }
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          new Blob([new Uint8Array([137, 80, 78, 71])], {
            type: "image/png",
          })
        )
      )
    )
    try {
      const doc = vi.fn(() => photo)
      render(<ExportMenu document={doc} name="Map" modes />)
      open()
      const box = await screen.findByRole("menuitemcheckbox", {
        name: "Photos",
      })
      expect(box.getAttribute("aria-checked")).toBe("false")
      fireEvent.click(await screen.findByRole("menuitem", { name: "draw.io" }))
      await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
      expect(String(download.mock.calls[0][2])).not.toContain(
        "image=data:image/png,"
      )
      expect(fetch).not.toHaveBeenCalled()
      open()
      fireEvent.click(
        await screen.findByRole("menuitemcheckbox", { name: "Photos" })
      )
      fireEvent.click(await screen.findByRole("menuitem", { name: "draw.io" }))
      await waitFor(() => expect(download).toHaveBeenCalledTimes(2))
      expect(String(download.mock.calls[1][2])).toContain(
        "image=data:image/png,iVBORw"
      )
      expect(
        JSON.parse(localStorage.getItem("topology:export")!)
      ).toMatchObject({ photos: true })
    } finally {
      fetch.mockRestore()
    }
  })

  it("keeps the canvas capture for a legacy tab's PNG, and draw.io Simple", async () => {
    const capture = vi.fn(() => Promise.resolve(null))
    const doc = vi.fn(() => fabric)
    render(<ExportMenu document={doc} capturePng={capture} name="Map" />)
    open()
    expect(screen.queryByText("Detailed")).toBeNull()
    fireEvent.click(await screen.findByText("PNG"))
    await waitFor(() => expect(capture).toHaveBeenCalledWith(false))
    expect(doc).not.toHaveBeenCalled()
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "draw.io" }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(doc).toHaveBeenCalledWith({ area: "all", mode: "simple" })
  })
})

describe("exportFileName", () => {
  const day = new Date(2026, 8, 26)
  it("names the file after the view and the day", () => {
    expect(exportFileName("DC1 fabric", "svg", day)).toBe(
      "dc1-fabric-2026-09-26.svg"
    )
    expect(exportFileName("Århus DC / core", "png", day)).toBe(
      "arhus-dc-core-2026-09-26.png"
    )
    expect(exportFileName("  ", "drawio", day)).toBe(
      "topology-2026-09-26.drawio"
    )
    expect(exportFileName("x".repeat(80), "svg", day)).toBe(
      `${"x".repeat(60)}-2026-09-26.svg`
    )
  })
})
