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

import type * as PngModule from "@/lib/diagram/png"
import { downloadBlob } from "@/lib/table-export"
import { DrawingExportMenu } from "./drawing-export-menu"
import type { DrawingBuild, DrawingRequest } from "./drawing-export-menu"

// A drawing's Export menu: PNG and SVG from the one drawing, PDF… on the
// paper the dialog asks for, Print on the paper last chosen, and a picture of
// the screen for a mode the drawing does not cover.

vi.mock("@/lib/table-export", () => ({ downloadBlob: vi.fn() }))
// jsdom draws no canvas: the PNG writer answers with an empty image, and
// there is no font to fetch.
vi.mock("@/lib/diagram/png", async (load) => ({
  ...(await load<typeof PngModule>()),
  svgToPng: vi.fn(() => Promise.resolve(new Blob([], { type: "image/png" }))),
  interFonts: vi.fn(() =>
    Promise.resolve([{ family: "Inter", src: "data:font/woff2;base64,AA==" }])
  ),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}))

const download = vi.mocked(downloadBlob)
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"/>'
const LINK = "/api/racks/r1/export/pdf/abcdefghijklmnopqrstuvwxyz0123/"
const day = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

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
  localStorage.clear()
  download.mockClear()
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

function menu(
  props: Partial<React.ComponentProps<typeof DrawingExportMenu>> = {}
) {
  const build = vi.fn<(req: DrawingRequest) => Promise<DrawingBuild | null>>(
    () => Promise.resolve({ svg: SVG, missing: 0 })
  )
  render(
    <DrawingExportMenu
      name="R12 elevation"
      build={build}
      pdfUrl="/api/racks/r1/export/pdf/"
      paperKey="rack:export"
      defaultPaper={{ size: "a4", orientation: "portrait" }}
      {...props}
    />
  )
  return build
}

describe("DrawingExportMenu", () => {
  it("saves the drawing as an SVG, Inter inlined and headed", async () => {
    const build = menu()
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "SVG" }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(download).toHaveBeenCalledWith(
      `r12-elevation-${day()}.svg`,
      "image/svg+xml",
      SVG
    )
    expect(build).toHaveBeenCalledWith({
      fonts: [{ family: "Inter", src: "data:font/woff2;base64,AA==" }],
      heading: true,
    })
  })

  it("rasterises the same drawing for the PNG", async () => {
    const png = await import("@/lib/diagram/png")
    menu()
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "PNG" }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(png.svgToPng).toHaveBeenCalledWith(SVG, { scale: 2 })
    expect(download.mock.calls[0][0]).toBe(`r12-elevation-${day()}.png`)
  })

  it("takes the PNG from the screen where the drawing can't, and says what the rest draw", async () => {
    const snapshot = vi.fn(() => Promise.resolve())
    const build = menu({ snapshot, note: "SVG and PDF in the Images look" })
    open()
    expect(
      await screen.findByText("SVG and PDF in the Images look")
    ).toBeTruthy()
    fireEvent.click(await screen.findByRole("menuitem", { name: "PNG" }))
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
    expect(build).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it("asks for the paper, posts the drawing without its heading, and saves the PDF", async () => {
    const fetch = answer(ok)
    const build = menu({ note: "SVG and PDF in the Images look" })
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "PDF…" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("SVG and PDF in the Images look")
    // A rack's paper until one is chosen.
    const current = () =>
      [...dialog.querySelectorAll('[aria-current="page"]')].map(
        (b) => b.textContent
      )
    expect(current()).toEqual(["A4", "Portrait"])
    fireEvent.click(screen.getByRole("button", { name: "A3" }))
    fireEvent.click(screen.getByRole("button", { name: "Landscape" }))
    fireEvent.click(screen.getByRole("button", { name: "Download" }))
    await waitFor(() => expect(clicks).toHaveLength(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(posted[0].url).toBe("/api/racks/r1/export/pdf/?print=1")
    expect(posted[0].body).toEqual({
      svg: SVG,
      paper: { size: "a3", orientation: "landscape" },
    })
    // The server titles the sheet; the PDF has its own fonts.
    expect(build).toHaveBeenCalledWith({ fonts: [], heading: false })
    expect(clicks[0].getAttribute("href")).toBe(`${LINK}?download=1`)
    expect(clicks[0].download).toBe(`r12-elevation-${day()}.pdf`)
    // Remembered, and shown where Print uses it.
    expect(JSON.parse(localStorage.getItem("rack:export")!)).toEqual({
      size: "a3",
      orientation: "landscape",
    })
    open()
    expect(
      (await screen.findByRole("menuitem", { name: /^Print/ })).textContent
    ).toContain("A3 landscape")
  })

  it("prints on the paper last chosen, in a tab opened by the click", async () => {
    localStorage.setItem(
      "cabinet:export",
      JSON.stringify({ size: "letter", orientation: "portrait" })
    )
    answer(ok)
    const tab = fakeTab()
    const openTab = vi
      .spyOn(window, "open")
      .mockReturnValue(tab as unknown as Window)
    menu({
      paperKey: "cabinet:export",
      defaultPaper: { size: "a4", orientation: "landscape" },
    })
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Print/ }))
    expect(openTab).toHaveBeenCalledWith("", "_blank")
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(LINK))
    expect(posted[0].body.paper).toEqual({
      size: "letter",
      orientation: "portrait",
    })
    expect(tab.opener).toBeNull()
    expect(tab.close).not.toHaveBeenCalled()
    expect(clicks).toHaveLength(0)
  })

  it("closes the tab and says why when the server refuses", async () => {
    answer(
      () =>
        new Response(
          JSON.stringify({ detail: "A PDF is already being made." }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }
        )
    )
    const tab = fakeTab()
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window)
    menu()
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Print/ }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("A PDF is already being made.")
    )
    expect(tab.close).toHaveBeenCalled()
    expect(tab.location.replace).not.toHaveBeenCalled()
  })

  it("says how many photos are drawn without them", async () => {
    menu({
      build: () => Promise.resolve({ svg: SVG, missing: 2 }),
    })
    open()
    fireEvent.click(await screen.findByRole("menuitem", { name: "SVG" }))
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "2 photos didn't load and are drawn as boxes"
      )
    )
    expect(download).toHaveBeenCalledTimes(1)
  })
})
