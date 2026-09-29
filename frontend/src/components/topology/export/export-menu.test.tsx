// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DRAWIO_MIME } from "@/lib/diagram/drawio"
import { fabric } from "@/lib/diagram/__fixtures__/fabric"
import type * as PngModule from "@/lib/diagram/png"
import { downloadBlob } from "@/lib/table-export"
import { ExportMenu, exportFileName } from "./export-menu"

// The one Export menu: each entry writes its file from the map's document,
// and the area and draw.io mode choices reach the document builder.

vi.mock("@/lib/table-export", () => ({ downloadBlob: vi.fn() }))
// jsdom draws no canvas: the PNG writer answers with an empty image.
vi.mock("@/lib/diagram/png", async (load) => ({
  ...(await load<typeof PngModule>()),
  diagramToPng: vi.fn(() =>
    Promise.resolve(new Blob([], { type: "image/png" }))
  ),
}))
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

  it("exports draw.io in the mode the map is shown in by default", async () => {
    const doc = vi.fn(() => fabric)
    render(
      <ExportMenu document={doc} name="DC1 fabric" modes shownMode="detailed" />
    )
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "draw.io" }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(doc).toHaveBeenCalledWith({ area: "all", mode: "detailed" })
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

  it("draws every tab's PNG from its document, and draw.io Simple", async () => {
    const doc = vi.fn(() => fabric)
    render(<ExportMenu document={doc} name="Map" />)
    open()
    expect(screen.queryByText("Detailed")).toBeNull()
    fireEvent.click(await screen.findByText("PNG"))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    // The same document the SVG, PDF and draw.io files are written from.
    expect(doc).toHaveBeenCalledWith({ area: "all", mode: undefined })
    const [file, mime] = download.mock.calls[0]
    expect(file).toBe(`${exportFileName("Map", "x").slice(0, -2)}.png`)
    expect(mime).toBe("image/png")
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "draw.io" }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2))
    expect(doc).toHaveBeenLastCalledWith({ area: "all", mode: "simple" })
  })
})

describe("ExportMenu PDF and Print", () => {
  const LINK = "/api/topology/export/pdf/abcdefghijklmnopqrstuvwxyz0123/"
  let posted: { url: string; body: Record<string, unknown> }[] = []
  let clicks: HTMLAnchorElement[] = []

  function answer(res: () => Response) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      posted.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      })
      return Promise.resolve(res())
    })
  }
  const ok = () =>
    new Response(JSON.stringify({ url: LINK }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

  function fakeTab() {
    return {
      opener: {} as unknown,
      document: { title: "" },
      location: { replace: vi.fn() },
      close: vi.fn(),
    }
  }

  beforeEach(() => {
    posted = []
    clicks = []
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.warning).mockClear()
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push(this)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("posts the SVG drawing on A3 landscape and saves the PDF", async () => {
    const fetch = answer(ok)
    const doc = vi.fn(() => fabric)
    render(<ExportMenu document={doc} name="DC1 fabric" modes />)
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "PDF" }))
    await waitFor(() => expect(clicks).toHaveLength(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    const { url, body } = posted[0]
    expect(url).toBe("/api/topology/export/pdf/?print=1")
    expect(body.paper).toEqual({ size: "a3", orientation: "landscape" })
    expect(body.title).toBe(fabric.meta.title)
    expect(body.title_block).toBe(true)
    expect(body.meta).toMatchObject({
      view: "DC1 fabric",
      generated_at: fabric.meta.generated_at,
    })
    const svg = String(body.svg)
    expect(svg).toMatch(/^<svg /)
    // The sheet has its own title block, and paper has no links.
    expect(svg).not.toContain("<a ")
    expect(doc).toHaveBeenCalledWith({ area: "all", mode: undefined })
    expect(clicks[0].getAttribute("href")).toBe(`${LINK}?download=1`)
    expect(clicks[0].download).toBe(`${today}.pdf`)
    expect(download).not.toHaveBeenCalled()
  })

  it("remembers the paper", async () => {
    answer(ok)
    render(<ExportMenu document={() => fabric} name="Map" />)
    open()
    fireEvent.click(await screen.findByText("Paper"))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "A4" }))
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Portrait" })
    )
    expect(JSON.parse(localStorage.getItem("topology:export")!)).toMatchObject({
      paper: "a4",
      orientation: "portrait",
    })
    expect(screen.getByText("A4 portrait")).toBeTruthy()
    cleanup()
    render(<ExportMenu document={() => fabric} name="Map" />)
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "PDF" }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.paper).toEqual({
      size: "a4",
      orientation: "portrait",
    })
  })

  it("prints in a tab opened by the click", async () => {
    answer(ok)
    const tab = fakeTab()
    const openTab = vi
      .spyOn(window, "open")
      .mockReturnValue(tab as unknown as Window)
    render(<ExportMenu document={() => fabric} name="Map" />)
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "Print" }))
    // Opened before the drawing is made, so it isn't taken for a pop-up.
    expect(openTab).toHaveBeenCalledWith("", "_blank")
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(LINK))
    expect(tab.opener).toBeNull()
    expect(tab.close).not.toHaveBeenCalled()
    expect(clicks).toHaveLength(0)
  })

  it("downloads when pop-ups are blocked", async () => {
    answer(ok)
    vi.spyOn(window, "open").mockReturnValue(null)
    render(<ExportMenu document={() => fabric} name="Map" />)
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "Print" }))
    await waitFor(() => expect(clicks).toHaveLength(1))
    expect(clicks[0].getAttribute("href")).toBe(`${LINK}?download=1`)
    expect(toast.warning).toHaveBeenCalled()
  })

  it("closes the tab and says why when the server refuses", async () => {
    answer(
      () =>
        new Response(
          JSON.stringify({
            detail: "The drawing has over 80,000 characters of text.",
          }),
          { status: 413, headers: { "Content-Type": "application/json" } }
        )
    )
    const tab = fakeTab()
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window)
    render(<ExportMenu document={() => fabric} name="Map" />)
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "Print" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "The drawing has over 80,000 characters of text."
      )
    )
    expect(tab.close).toHaveBeenCalled()
    expect(tab.location.replace).not.toHaveBeenCalled()
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
