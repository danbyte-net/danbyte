// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ChassisPalette, filterChassis } from "./chassis-palette"
import type { ChassisPaletteProps, TopologyChassisRow } from "./chassis-palette"
import { DevicePalette } from "./device-palette"
import type { DevicePaletteProps, PaletteKind } from "./device-palette"
import { CHASSIS_IDS_MIME } from "./diagram/placement"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis))
  (globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub

const STACK: TopologyChassisRow = {
  id: "vc-1",
  name: "access-stack-1",
  master_id: "d-1",
  members: [
    { id: "d-1", name: "acc1-sw1", vc_position: 1 },
    { id: "d-2", name: "acc1-sw2", vc_position: 2 },
  ],
}
const CORE: TopologyChassisRow = {
  id: "vc-2",
  name: "core-vc",
  master_id: null,
  members: [{ id: "d-3", name: "core-a", vc_position: null }],
}

function serve(rows: TopologyChassisRow[]) {
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/topology/chassis/")
      return Promise.resolve({ results: rows })
    if (path.startsWith("/api/devices/?picker=palette"))
      return Promise.resolve({ count: 0, results: [] })
    return Promise.resolve({ results: [] })
  })
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

function renderList(over: Partial<ChassisPaletteProps> = {}) {
  const props: ChassisPaletteProps = {
    placed: new Set<string>(),
    editable: true,
    onAdd: vi.fn(),
    ...over,
  }
  render(
    <QueryClientProvider client={client()}>
      <ChassisPalette {...props} />
    </QueryClientProvider>
  )
  return props
}

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-chassis="${id}"]`)!

beforeEach(() => serve([STACK, CORE]))
afterEach(cleanup)

describe("filterChassis", () => {
  it("matches a chassis' name or a member's", () => {
    expect(filterChassis([STACK, CORE], "")).toEqual([STACK, CORE])
    expect(filterChassis([STACK, CORE], "CORE")).toEqual([CORE])
    expect(filterChassis([STACK, CORE], "sw2")).toEqual([STACK])
    expect(filterChassis([STACK, CORE], "nothing")).toEqual([])
  })
})

describe("ChassisPalette", () => {
  it("lists each chassis with its members and their count", async () => {
    renderList()
    await screen.findByText("access-stack-1")
    const r = row("vc-1")
    expect(within(r).getByText("acc1-sw1 · acc1-sw2")).toBeTruthy()
    // The count is a squarish badge, never a round pill.
    const count = within(r).getByText("2")
    expect(count.className).not.toContain("rounded-full")
  })

  it("dims and ticks a chassis already placed, and won't drag it", async () => {
    const props = renderList({ placed: new Set(["vc-1"]) })
    await screen.findByText("access-stack-1")
    const placed = row("vc-1")
    expect(placed.dataset.placed).toBe("true")
    expect(placed.getAttribute("draggable")).toBe("false")
    expect(within(placed).getByLabelText("On the map")).toBeTruthy()
    fireEvent.doubleClick(placed)
    expect(props.onAdd).not.toHaveBeenCalled()
  })

  it("drags the chassis id with its own type", async () => {
    renderList()
    await screen.findByText("core-vc")
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn((k: string, v: string) => data.set(k, v)),
    }
    fireEvent.dragStart(row("vc-2"), { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe("copy")
    expect(JSON.parse(data.get(CHASSIS_IDS_MIME)!)).toEqual(["vc-2"])
  })

  it("adds on double-click and on Enter", async () => {
    const props = renderList()
    await screen.findByText("core-vc")
    fireEvent.doubleClick(row("vc-2"))
    expect(props.onAdd).toHaveBeenLastCalledWith([CORE])
    fireEvent.keyDown(row("vc-1"), { key: "Enter" })
    expect(props.onAdd).toHaveBeenLastCalledWith([STACK])
  })

  it("adds nothing on a map that follows its filters", async () => {
    const props = renderList({ editable: false })
    await screen.findByText("core-vc")
    expect(row("vc-2").getAttribute("draggable")).toBe("false")
    fireEvent.doubleClick(row("vc-2"))
    expect(props.onAdd).not.toHaveBeenCalled()
  })

  it("searches, and says when there is nothing", async () => {
    renderList()
    await screen.findByText("core-vc")
    fireEvent.change(screen.getByLabelText("Search virtual chassis"), {
      target: { value: "zzz" },
    })
    expect(await screen.findByText("No matches.")).toBeTruthy()
    cleanup()
    serve([])
    renderList()
    expect(await screen.findByText("No virtual chassis yet.")).toBeTruthy()
  })
})

describe("DevicePalette kinds", () => {
  function renderPalette(kind: PaletteKind, withChassis = true) {
    const onKind = vi.fn()
    const props: DevicePaletteProps = {
      placed: new Set<string>(),
      editable: true,
      onAdd: vi.fn(),
      onFocus: vi.fn(),
      onClose: vi.fn(),
      ...(withChassis
        ? {
            chassis: {
              kind,
              onKind,
              placed: new Set<string>(),
              onAdd: vi.fn(),
            },
          }
        : {}),
    }
    render(
      <QueryClientProvider client={client()}>
        <div style={{ height: 800 }}>
          <DevicePalette {...props} />
        </div>
      </QueryClientProvider>
    )
    return onKind
  }

  it("switches between devices and virtual chassis", async () => {
    const onKind = renderPalette("devices")
    expect(screen.getByLabelText("Search devices")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Virtual chassis" }))
    expect(onKind).toHaveBeenCalledWith("chassis")
  })

  it("lists the virtual chassis on that kind", async () => {
    renderPalette("chassis")
    expect(await screen.findByText("access-stack-1")).toBeTruthy()
    expect(screen.queryByLabelText("Search devices")).toBeNull()
  })

  it("offers devices only where chassis cannot be placed", () => {
    renderPalette("devices", false)
    expect(screen.queryByRole("button", { name: "Virtual chassis" })).toBeNull()
    expect(screen.getByLabelText("Search devices")).toBeTruthy()
  })
})
