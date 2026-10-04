// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { DeviceType, ImagePorts } from "@/lib/api"
import { DeviceTypeImagePortsPane } from "./device-type-image-ports-pane"

// The photo editor's calibrate mode (#277): guides on the photo, the real
// distance between them, the rail line - saved in the side's view beside its
// saved size, with the markers left as they are. A document without markers
// still saves while it holds a size or a calibration.

const { apiMock, canDoMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canDoMock: vi.fn(() => true),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canDo: canDoMock }) }))

const P1 = { kind: "interface", name: "P1", x: 0.59, y: 0.1, w: 0.17, h: 0.09 }
const CAL = { left: 0.1, right: 0.9, span_mm: 48, rail: 0.55 }
/** A new calibration: the photo's edges, the type's 60 mm, the middle. */
const EDGES = { left: 0, right: 1, span_mm: 60, rail: 0.5 }

const type = (image_ports: ImagePorts | null) =>
  ({
    id: "t1",
    name: "XC206",
    front_image: "/media/xc206.png",
    rear_image: null,
    width_mm: 60,
    height_mm: 147,
    din_rail_mm: null,
    din_profiles: ["ts35"],
    image_ports,
  }) as unknown as DeviceType

function draw(
  deviceType: DeviceType,
  device?: { id: string; name: string; image_ports: ImagePorts | null }
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <DeviceTypeImagePortsPane deviceType={deviceType} device={device} />
    </QueryClientProvider>
  )
  // The photo loads 163 × 398 px: 60 mm wide is 146.5 mm tall.
  const img = screen.getByAltText("front of XC206")
  Object.defineProperty(img, "naturalWidth", { value: 163 })
  Object.defineProperty(img, "naturalHeight", { value: 398 })
  fireEvent.load(img)
}

/** The image_ports of the one PATCH Save sent, and where it went. */
async function saved(): Promise<{ path: string; doc: ImagePorts | null }> {
  fireEvent.click(screen.getByRole("button", { name: "Save photo ports" }))
  await waitFor(() =>
    expect(
      apiMock.mock.calls.filter(([, i]) => i?.method === "PATCH")
    ).toHaveLength(1)
  )
  const [path, init] = apiMock.mock.calls.find(
    ([, i]) => i?.method === "PATCH"
  )!
  const body = JSON.parse(String(init?.body)) as {
    image_ports: ImagePorts | null
  }
  return { path, doc: body.image_ports }
}

const calibrate = () =>
  fireEvent.click(screen.getByRole("button", { name: "Calibrate" }))
const guide = (name: string) => screen.getByRole("slider", { name })
const distance = () => screen.getByLabelText("Distance (mm)")

beforeEach(() => {
  canDoMock.mockReturnValue(true)
  apiMock.mockReset()
  apiMock.mockImplementation((_path, init) =>
    Promise.resolve(
      init?.method === "PATCH"
        ? {}
        : { count: 0, next: null, previous: null, results: [] }
    )
  )
})

afterEach(cleanup)

describe("calibrate mode", () => {
  it("starts on the photo's edges at the type's width, and reads the photo's size", () => {
    draw(type({ front: [P1], rear: [] }))
    calibrate()
    expect(distance()).toHaveProperty("value", "60")
    expect(guide("Left guide").getAttribute("aria-valuenow")).toBe("0")
    expect(guide("Right guide").getAttribute("aria-valuenow")).toBe("100")
    expect(guide("Rail line").getAttribute("aria-valuenow")).toBe("50")
    expect(screen.getByText("Photo 60.0 × 146.5 mm")).toBeTruthy()
    // A TS 35 rail at that scale: 35 of the photo's 146.5 mm.
    const band = document.querySelector<HTMLElement>("[data-part=rail-band]")
    expect(parseFloat(band!.style.height)).toBeCloseTo((35 / 146.5) * 100, 1)
  })

  it("saves the calibration beside the saved size, the markers kept", async () => {
    draw(type({ front: [P1], rear: [], view: { front: { scale: 0.3 } } }))
    calibrate()
    fireEvent.change(distance(), { target: { value: "58" } })
    fireEvent.keyDown(guide("Left guide"), { key: "ArrowRight" })
    fireEvent.keyDown(guide("Right guide"), {
      key: "ArrowLeft",
      shiftKey: true,
    })
    fireEvent.keyDown(guide("Rail line"), { key: "ArrowDown" })
    // The other axis does not move a guide.
    fireEvent.keyDown(guide("Left guide"), { key: "ArrowUp" })
    // 58 mm over 0.988 of the photo.
    expect(screen.getByText("Photo 58.7 × 143.3 mm")).toBeTruthy()
    const { path, doc } = await saved()
    expect(path).toBe("/api/device-types/t1/")
    expect(doc).toEqual({
      front: [P1],
      rear: [],
      view: {
        front: {
          scale: 0.3,
          cal: { left: 0.002, right: 0.99, span_mm: 58, rail: 0.502 },
        },
      },
    })
  })

  it("reads a calibration sent without guides as the server does", () => {
    // The API takes the guides to be the photo's edges when left out.
    draw(
      type({
        front: [],
        rear: [],
        view: { front: { cal: { span_mm: 120 } as typeof CAL } },
      })
    )
    calibrate()
    expect(distance()).toHaveProperty("value", "120")
    expect(guide("Left guide").getAttribute("aria-valuenow")).toBe("0")
    expect(guide("Right guide").getAttribute("aria-valuenow")).toBe("100")
    expect(guide("Rail line").getAttribute("aria-valuenow")).toBe("50")
  })

  it("zooms without touching the saved size", async () => {
    draw(type({ front: [P1], rear: [], view: { front: { scale: 0.3 } } }))
    expect(screen.getByText("30%")).toBeTruthy()
    calibrate()
    // Opened at the photo's own pixels, then magnified.
    expect(screen.queryByText("30%")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "+" }))
    expect(screen.getByText("150%")).toBeTruthy()
    fireEvent.change(distance(), { target: { value: "58" } })
    // Calibrate off: back at the saved size, which is what saves.
    calibrate()
    expect(screen.getByText("30%")).toBeTruthy()
    const { doc } = await saved()
    expect(doc?.view?.front).toEqual({
      scale: 0.3,
      cal: { ...EDGES, span_mm: 58 },
    })
  })

  it("removes the calibration on Clear, the saved size kept", async () => {
    draw(
      type({ front: [P1], rear: [], view: { front: { scale: 0.3, cal: CAL } } })
    )
    calibrate()
    expect(distance()).toHaveProperty("value", "48")
    fireEvent.click(screen.getByRole("button", { name: "Clear calibration" }))
    expect(screen.queryByRole("slider", { name: "Left guide" })).toBeNull()
    const { doc } = await saved()
    expect(doc).toEqual({
      front: [P1],
      rear: [],
      view: { front: { scale: 0.3 } },
    })
  })

  it("will not save a distance out of range", () => {
    draw(type({ front: [P1], rear: [] }))
    calibrate()
    fireEvent.change(distance(), { target: { value: "0" } })
    expect(screen.getByText("1–5000 mm")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Save photo ports" })
    ).toHaveProperty("disabled", true)
  })
})

describe("a document without markers", () => {
  it("is kept when it holds a calibration", async () => {
    draw(type(null))
    calibrate()
    const { doc } = await saved()
    expect(doc).toEqual({
      front: [],
      rear: [],
      view: { front: { cal: EDGES } },
    })
  })

  it("is kept when it holds a saved size", async () => {
    draw(type(null))
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Use this size everywhere/ })
    )
    const { doc } = await saved()
    expect(doc).toEqual({
      front: [],
      rear: [],
      view: { front: { scale: null } },
    })
  })

  it("is cleared when nothing is left in it", async () => {
    draw(type({ front: [], rear: [], view: { front: { cal: CAL } } }))
    calibrate()
    fireEvent.click(screen.getByRole("button", { name: "Clear calibration" }))
    const { doc } = await saved()
    expect(doc).toBeNull()
  })
})

describe("on a device", () => {
  const device = { id: "d1", name: "sw-1", image_ports: null }
  const calibrated = () =>
    type({ front: [P1], rear: [], view: { front: { scale: 0.3, cal: CAL } } })

  it("shows the type's calibration as inherited until it sets its own", async () => {
    draw(calibrated(), device)
    calibrate()
    expect(screen.getByText("From type")).toBeTruthy()
    expect(distance()).toHaveProperty("value", "48")
    // Nothing of its own to clear, and nothing to save yet.
    expect(
      screen.queryByRole("button", { name: "Clear calibration" })
    ).toBeNull()
    expect(
      screen.getByRole("button", { name: "Save photo ports" })
    ).toHaveProperty("disabled", true)
    fireEvent.change(distance(), { target: { value: "24" } })
    expect(screen.queryByText("From type")).toBeNull()
    const { path, doc } = await saved()
    expect(path).toBe("/api/devices/d1/")
    // The type's markers and size come along, as for any override; the
    // calibration is the device's own.
    expect(doc).toEqual({
      front: [P1],
      rear: [],
      view: { front: { scale: 0.3, cal: { ...CAL, span_mm: 24 } } },
    })
  })

  it("keeps the type's calibration out of a new override", async () => {
    draw(calibrated(), device)
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Use this size everywhere/ })
    )
    const { doc } = await saved()
    // Size off: the override holds the markers, and inherits the calibration.
    expect(doc).toEqual({ front: [P1], rear: [] })
  })

  it("goes back to the type's calibration on Clear", () => {
    draw(calibrated(), {
      ...device,
      image_ports: {
        front: [P1],
        rear: [],
        view: { front: { cal: { ...CAL, span_mm: 24 } } },
      },
    })
    calibrate()
    expect(distance()).toHaveProperty("value", "24")
    fireEvent.click(screen.getByRole("button", { name: "Clear calibration" }))
    expect(distance()).toHaveProperty("value", "48")
    expect(screen.getByText("From type")).toBeTruthy()
  })
})

describe("read-only", () => {
  it("shows a saved calibration, and offers none to make", () => {
    canDoMock.mockReturnValue(false)
    draw(type({ front: [P1], rear: [] }))
    expect(screen.queryByRole("button", { name: "Calibrate" })).toBeNull()
    cleanup()
    draw(type({ front: [P1], rear: [], view: { front: { cal: CAL } } }))
    calibrate()
    expect(distance()).toHaveProperty("disabled", true)
    expect(guide("Left guide").getAttribute("aria-readonly")).toBe("true")
    expect(
      screen.queryByRole("button", { name: "Clear calibration" })
    ).toBeNull()
    fireEvent.keyDown(guide("Left guide"), { key: "ArrowRight" })
    expect(guide("Left guide").getAttribute("aria-valuenow")).toBe("10")
  })
})
