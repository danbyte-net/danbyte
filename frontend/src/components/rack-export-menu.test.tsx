// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Device, Rack } from "@/lib/api"
import { devices as fixture } from "@/lib/elevation/__fixtures__/rack"
import { downloadPng } from "@/lib/png-export"
import { downloadBlob } from "@/lib/table-export"
import { RackExportMenu } from "./rack-export-menu"

// The rack page's Export menu: the elevation's faces in the page's mode,
// from the devices the elevation lists - and in Render, a picture of the
// screen for the PNG.

vi.mock("@/lib/table-export", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/lib/png-export", () => ({ downloadPng: vi.fn() }))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}))

const download = vi.mocked(downloadBlob)

const rack = {
  id: "r1",
  name: "R12",
  u_height: 12,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  role: null,
  site: { id: "s1", name: "AMS" },
  location: null,
  used_units: 8,
} as unknown as Rack
const devices = fixture as unknown as Device[]

beforeEach(() => {
  download.mockClear()
  vi.mocked(downloadPng).mockClear()
})
afterEach(cleanup)

function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function open() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /export/i }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
}

async function svgOf(ui: React.ReactElement): Promise<string> {
  show(ui)
  open()
  fireEvent.click(await screen.findByRole("menuitem", { name: "SVG" }))
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
  const [file, mime, body] = download.mock.calls[0]
  expect(file).toMatch(/^r12-elevation-\d{4}-\d{2}-\d{2}\.svg$/)
  expect(mime).toBe("image/svg+xml")
  return String(body)
}

describe("RackExportMenu", () => {
  it("exports the front and the rear, as the page shows them", async () => {
    const svg = await svgOf(
      <RackExportMenu rack={rack} devices={devices} mode="names" />
    )
    expect(svg).toContain('id="rk-front"')
    expect(svg).toContain('id="rk-rear"')
    expect(svg).toContain(">srv-01<")
    expect(svg).not.toContain("<use")
  })

  it("exports the gear the Show filter keeps, the rest as hatched space", async () => {
    const svg = await svgOf(
      <RackExportMenu rack={rack} devices={devices} mode="names" show="rear" />
    )
    // srv-01 is mounted on the front: its units stay, with no name.
    expect(svg).not.toContain(">srv-01<")
    expect(svg).toContain(">rear-fan<")
    expect(svg).toContain("Rear-mounted")
  })

  it("exports one face", async () => {
    const svg = await svgOf(
      <RackExportMenu rack={rack} devices={devices} face="rear" mode="names" />
    )
    expect(svg).not.toContain('id="rk-front"')
    expect(svg).toContain('id="rk-rear"')
  })

  it("draws Render in the Images look, and pictures the screen for its PNG", async () => {
    const el = document.createElement("div")
    show(
      <RackExportMenu
        rack={rack}
        devices={devices}
        mode="render"
        snapshot={{ current: el }}
      />
    )
    open()
    expect(
      await screen.findByText("SVG and PDF in the Images look")
    ).toBeTruthy()
    fireEvent.click(await screen.findByRole("menuitem", { name: "PNG" }))
    await waitFor(() => expect(downloadPng).toHaveBeenCalledTimes(1))
    const [shot, name] = vi.mocked(downloadPng).mock.calls[0]
    expect(shot).toBe(el)
    expect(name).toMatch(/^r12-elevation-\d{4}-\d{2}-\d{2}\.png$/)
  })

  it("waits for the elevation's devices when it isn't given them", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {})
    )
    try {
      show(<RackExportMenu rack={rack} mode="names" />)
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: /export/i })
          .disabled
      ).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
