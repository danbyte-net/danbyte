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

import type * as Api from "@/lib/api"
import type { Rack, ResolvedPathway, ResolvedPathways } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { RackElevation } from "./rack-elevation"
import { PathwayPanel } from "./rack-pathway-layer"
import type { PathwayLayer } from "./rack-pathway-layer"

// The Pathways layer on the rack's elevation: the rack's vertical managers
// and channels beside the rails at their units, horizontal managers in
// theirs; a press opens one, a press on an empty spot adds one there, a
// bar's end drags to other units - all through /api/rack-pathways/, an
// inherited pathway through its overlay row. Who may not change pathways
// sees them and nothing to edit them with.

const { apiMock, rights } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  rights: { edit: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (model: string) => (model === "rackpathway" ? rights.edit : false),
    faceplateMarkedLit: false,
    faceplatePortLabels: "",
    faceplatePortLabelColor: "#ffffff",
    faceplateGroupLabels: false,
  }),
}))
vi.mock("@/lib/save-object", async (orig) => ({
  ...(await orig<object>()),
  usePlanTarget: () => null,
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

const RACK = {
  id: "r1",
  name: "R1",
  u_height: 10,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  role: null,
  used_units: 0,
} as unknown as Rack

const pw = (over: Partial<ResolvedPathway>): ResolvedPathway => ({
  key: "k",
  id: null,
  source: "kit",
  kind: "vertical",
  subkind: "",
  side: "",
  face: "",
  surface: "",
  u_from: null,
  u_to: null,
  offset_mm: null,
  depth_mm: null,
  x_mm: null,
  y_mm: null,
  inner_w_mm: null,
  inner_d_mm: null,
  fill_limit_pct: 40,
  name: "",
  description: "",
  label: "P",
  hidden: false,
  addon: false,
  orphan: false,
  overridden: [],
  accessory_type: null,
  device: null,
  ...over,
})

const LEFT_FRONT = pw({
  key: "path:vertical:left:front",
  subkind: "finger",
  side: "left",
  face: "front",
  u_from: 1,
  u_to: 10,
  label: "Left front",
})
const RIGHT_REAR = pw({
  key: "path:vertical:right:rear",
  subkind: "channel",
  side: "right",
  face: "rear",
  u_from: 1,
  u_to: 10,
  label: "Right rear",
})
const MANUAL_RIGHT = pw({
  key: "manual:m1",
  id: "m1",
  source: "manual",
  subkind: "d-ring",
  side: "right",
  face: "front",
  u_from: 3,
  u_to: 6,
  label: "Right front",
})
const BRUSH = pw({
  key: "manual:h1",
  id: "h1",
  source: "manual",
  kind: "horizontal",
  subkind: "brush",
  face: "front",
  u_from: 8,
  u_to: 8,
  label: "U8 front",
})
const HIDDEN = pw({
  key: "path:vertical:left:full",
  side: "left",
  face: "full",
  u_from: 1,
  u_to: 10,
  hidden: true,
  addon: true,
  label: "Left full depth",
})

const DOC: ResolvedPathways = {
  frame: "cabinet",
  kit: null,
  units: [1, 10],
  fill_limit_pct: 40,
  items: [LEFT_FRONT, RIGHT_REAR, MANUAL_RIGHT, BRUSH, HIDDEN],
}

function serve(path: string, init?: RequestInit): Promise<unknown> {
  if (init?.method && init.method !== "GET")
    return Promise.resolve({ id: "new1" })
  if (path.startsWith("/api/rack-pathways/resolved/"))
    return Promise.resolve(DOC)
  if (path.startsWith("/api/devices/"))
    return Promise.resolve({ count: 0, next: null, results: [] })
  if (path.startsWith("/api/planning/"))
    return Promise.resolve({ count: 0, next: null, results: [] })
  return Promise.resolve({ count: 0, next: null, results: [] })
}

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

function layer(): PathwayLayer & { onOpen: ReturnType<typeof vi.fn> } {
  return { selected: null, onOpen: vi.fn() }
}

const writes = () =>
  apiMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")

beforeEach(() => {
  rights.edit = true
  apiMock.mockReset()
  apiMock.mockImplementation(serve)
  // Rows 42px high, from the top of whatever is measured.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    left: 0,
    width: 400,
    height: 420,
    right: 400,
    bottom: 420,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const bar = async (key: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-pathway="${key}"]`)
    if (!el) throw new Error(`no ${key}`)
    return el
  })

describe("the Pathways layer", () => {
  it("draws nothing new when it is off", async () => {
    wrap(<RackElevation rack={RACK} face="front" showHeader={false} />)
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) => p.includes("/api/devices/"))
      ).toBe(true)
    )
    expect(document.querySelector("[data-pathway-strip]")).toBeNull()
    expect(document.querySelector("[data-pathway]")).toBeNull()
    expect(
      apiMock.mock.calls.some(([p]) => p.includes("/api/rack-pathways/"))
    ).toBe(false)
  })

  it("draws a face's pathways at their units and sides", async () => {
    wrap(
      <RackElevation
        rack={RACK}
        face="front"
        showHeader={false}
        pathways={layer()}
      />
    )
    const left = await bar(LEFT_FRONT.key)
    expect(
      left.closest("[data-pathway-strip]")?.getAttribute("data-pathway-strip")
    ).toBe("left")
    expect(left.style.gridRow).toBe("1 / span 10")
    expect(left.textContent).toContain("Finger")
    expect(left.textContent).toContain("Kit")
    const manual = await bar(MANUAL_RIGHT.key)
    expect(
      manual.closest("[data-pathway-strip]")?.getAttribute("data-pathway-strip")
    ).toBe("right")
    // U6 is the fifth row down from U10.
    expect(manual.style.gridRow).toBe("5 / span 4")
    expect(manual.textContent).toContain("Manual")
    const brush = await bar(BRUSH.key)
    expect(brush.closest("[data-pathway-strip]")).toBeNull()
    expect(brush.style.gridRow).toBe("3 / span 1")
    // The rear's channel and the hidden add-on are not on the front.
    expect(
      document.querySelector(`[data-pathway="${RIGHT_REAR.key}"]`)
    ).toBeNull()
    expect(document.querySelector(`[data-pathway="${HIDDEN.key}"]`)).toBeNull()
  })

  it("draws the rear's on the rear", async () => {
    wrap(
      <RackElevation
        rack={RACK}
        face="rear"
        showHeader={false}
        pathways={layer()}
      />
    )
    expect((await bar(RIGHT_REAR.key)).textContent).toContain("Channel")
    expect(
      document.querySelector(`[data-pathway="${LEFT_FRONT.key}"]`)
    ).toBeNull()
  })

  it("opens a pathway pressed", async () => {
    const l = layer()
    wrap(
      <RackElevation rack={RACK} face="front" showHeader={false} pathways={l} />
    )
    fireEvent.click(await bar(LEFT_FRONT.key))
    expect(l.onOpen).toHaveBeenCalledWith({ key: LEFT_FRONT.key })
  })

  it("adds a manager over the free units pressed", async () => {
    const l = layer()
    wrap(
      <RackElevation rack={RACK} face="front" showHeader={false} pathways={l} />
    )
    await bar(MANUAL_RIGHT.key)
    const strip = document.querySelector('[data-pathway-strip="right"]')!
    fireEvent.click(strip.querySelector('[data-unit="9"]')!)
    expect(l.onOpen).toHaveBeenCalledWith({
      preset: {
        kind: "vertical",
        side: "right",
        face: "front",
        u_from: "7",
        u_to: "10",
      },
    })
    // An empty unit of the grid: a horizontal manager there.
    fireEvent.click(
      document.querySelector('[data-unit="5"]:not([aria-hidden])')!
    )
    expect(l.onOpen).toHaveBeenLastCalledWith({
      preset: { kind: "horizontal", face: "front", u_from: "5", u_to: "5" },
    })
  })

  it("posts the new pathway the panel's form adds", async () => {
    wrap(
      <PathwayPanel
        rackId="r1"
        target={{
          preset: {
            kind: "vertical",
            side: "right",
            face: "front",
            u_from: "7",
            u_to: "10",
          },
        }}
        onClose={() => undefined}
        onSelect={() => undefined}
      />
    )
    fireEvent.click(await screen.findByRole("button", { name: "Add pathway" }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [path, init] = writes()[0]
    expect(path).toBe("/api/rack-pathways/")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      rack_id: "r1",
      kind: "vertical",
      side: "right",
      face: "front",
      u_from: 7,
      u_to: 10,
    })
  })

  it("saves a dragged end: a row of its own patched", async () => {
    wrap(
      <RackElevation
        rack={RACK}
        face="front"
        showHeader={false}
        pathways={layer()}
      />
    )
    const manual = await bar(MANUAL_RIGHT.key)
    // Its top end (U6) up to the second row down: U9.
    fireEvent.pointerDown(manual.querySelector('[data-end="top"]')!, {
      button: 0,
      clientY: 4 * 42 + 5,
    })
    fireEvent.pointerMove(window, { clientY: 1 * 42 + 5 })
    fireEvent.pointerUp(window, { clientY: 1 * 42 + 5 })
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [path, init] = writes()[0]
    expect(path).toBe("/api/rack-pathways/m1/")
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(String(init?.body))).toEqual({ u_to: 9 })
  })

  it("saves a dragged end of a kit's on its overlay row", async () => {
    wrap(
      <RackElevation
        rack={RACK}
        face="front"
        showHeader={false}
        pathways={layer()}
      />
    )
    const left = await bar(LEFT_FRONT.key)
    // Its foot (U1) up to U3, the eighth row down.
    fireEvent.pointerDown(left.querySelector('[data-end="bottom"]')!, {
      button: 0,
      clientY: 9 * 42 + 5,
    })
    fireEvent.pointerUp(window, { clientY: 7 * 42 + 5 })
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [path, init] = writes()[0]
    expect(path).toBe("/api/rack-pathways/")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({
      rack_id: "r1",
      key: LEFT_FRONT.key,
      u_from: 3,
    })
  })

  it("drags a horizontal manager to a free unit", async () => {
    wrap(
      <RackElevation
        rack={RACK}
        face="front"
        showHeader={false}
        pathways={layer()}
      />
    )
    const brush = await bar(BRUSH.key)
    fireEvent.pointerDown(brush, { button: 0, clientY: 2 * 42 + 5 })
    fireEvent.pointerMove(window, { clientY: 5 * 42 + 5 })
    fireEvent.pointerUp(window, { clientY: 5 * 42 + 5 })
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [path, init] = writes()[0]
    expect(path).toBe("/api/rack-pathways/h1/")
    expect(JSON.parse(String(init?.body))).toEqual({ u_from: 5, u_to: 5 })
  })

  it("gives who may not change pathways nothing to edit them with", async () => {
    rights.edit = false
    const l = layer()
    wrap(
      <RackElevation rack={RACK} face="front" showHeader={false} pathways={l} />
    )
    const manual = await bar(MANUAL_RIGHT.key)
    expect(manual.querySelector("[data-end]")).toBeNull()
    const strip = document.querySelector('[data-pathway-strip="right"]')!
    fireEvent.click(strip.querySelector('[data-unit="9"]')!)
    fireEvent.click(
      document.querySelector('[data-unit="5"]:not([aria-hidden])')!
    )
    expect(l.onOpen).not.toHaveBeenCalled()
    fireEvent.pointerDown(await bar(BRUSH.key), { button: 0, clientY: 90 })
    fireEvent.pointerUp(window, { clientY: 300 })
    // A press still opens it - to read.
    fireEvent.click(manual)
    expect(l.onOpen).toHaveBeenCalledWith({ key: MANUAL_RIGHT.key })
    expect(writes()).toHaveLength(0)

    cleanup()
    wrap(
      <PathwayPanel
        rackId="r1"
        target={{ key: MANUAL_RIGHT.key }}
        onClose={() => undefined}
        onSelect={() => undefined}
      />
    )
    expect(await screen.findByText("Units")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
  })
})
