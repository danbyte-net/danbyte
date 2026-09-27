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

import type { DevicePaletteRow } from "@/lib/api"
import {
  DevicePalette,
  WINDOW_OVER,
  filterPalette,
  groupPalette,
} from "./device-palette"
import type { DevicePaletteProps } from "./device-palette"
import { DEVICE_IDS_MIME } from "./diagram/placement"

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

const SPINE = {
  id: "r-spine",
  name: "Spine",
  slug: "spine",
  color: "7c3aed",
  is_patch_panel: false,
}
const LEAF = {
  id: "r-leaf",
  name: "Leaf",
  slug: "leaf",
  color: "0ea5e9",
  is_patch_panel: false,
}
const PANEL = {
  id: "r-panel",
  name: "Patch panel",
  slug: "patch-panel",
  color: "a1a1aa",
  is_patch_panel: true,
}
const SITE_A = { id: "s-a", name: "Aarhus" }
const SITE_B = { id: "s-b", name: "Billund" }
const ACTIVE = { id: "st-a", name: "Active", slug: "active", color: "22c55e" }

function dev(
  id: string,
  over: Partial<DevicePaletteRow> = {}
): DevicePaletteRow {
  return {
    id,
    numid: null,
    name: id,
    role: LEAF,
    device_type: {
      id: "t-1",
      name: "QFX5120",
      model: "QFX5120-48Y",
      manufacturer: null,
    },
    site: SITE_A,
    location: null,
    rack: null,
    status: ACTIVE as DevicePaletteRow["status"],
    has_photo: false,
    ...over,
  }
}

// The server's order: by role name, then natural name, role-less last.
const ROWS: DevicePaletteRow[] = [
  dev("leaf1", { rack: { id: "k-1", name: "R01" } }),
  dev("leaf2", { site: SITE_B, rack: { id: "k-2", name: "R02" } }),
  dev("pp1", { role: PANEL }),
  dev("spine1", { role: SPINE }),
  dev("spine2", { role: SPINE }),
  dev("loose", { role: null }),
]

function paletteWith(rows: DevicePaletteRow[]) {
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/api/devices/?picker=palette&tag=spines"))
      return Promise.resolve({
        count: 2,
        results: rows.filter((r) => r.role?.id === "r-spine"),
      })
    if (path.startsWith("/api/devices/?picker=palette"))
      return Promise.resolve({ count: rows.length, results: rows })
    return Promise.resolve({ count: 0, results: [] })
  })
}

function renderPalette(over: Partial<DevicePaletteProps> = {}) {
  const props: DevicePaletteProps = {
    placed: new Set<string>(),
    editable: true,
    onAdd: vi.fn(),
    onFocus: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <div style={{ height: 800 }}>
        <DevicePalette {...props} />
      </div>
    </QueryClientProvider>
  )
  return { ...view, props }
}

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-device="${id}"]`)!

/** A drag's data, as the canvas will read it. */
function dragFrom(el: HTMLElement) {
  const data = new Map<string, string>()
  const dataTransfer = {
    effectAllowed: "",
    setData: vi.fn((k: string, v: string) => data.set(k, v)),
    setDragImage: vi.fn(),
    types: [] as string[],
  }
  fireEvent.dragStart(el, { dataTransfer })
  return { data, dataTransfer }
}

beforeEach(() => paletteWith(ROWS))
afterEach(cleanup)

describe("filterPalette", () => {
  it("narrows by site, role, type, status and rack", () => {
    const ids = (f: Parameters<typeof filterPalette>[1]) =>
      filterPalette(ROWS, f).map((r) => r.id)
    expect(ids({ filters: { site: "s-b" } })).toEqual(["leaf2"])
    expect(ids({ filters: { role: "r-spine" } })).toEqual(["spine1", "spine2"])
    expect(ids({ filters: { rack: "k-1" } })).toEqual(["leaf1"])
    expect(ids({ filters: { device_type: "t-2" } })).toEqual([])
    expect(ids({ filters: { status: "st-a", role: "r-leaf" } })).toEqual([
      "leaf1",
      "leaf2",
    ])
  })

  it("narrows by the tag's matches and by search", () => {
    expect(
      filterPalette(ROWS, { tagIds: new Set(["pp1", "loose"]) }).map(
        (r) => r.id
      )
    ).toEqual(["pp1", "loose"])
    // Name, model, site and rack are searched, case-insensitively.
    expect(filterPalette(ROWS, { search: "SPINE" }).map((r) => r.id)).toEqual([
      "spine1",
      "spine2",
    ])
    expect(filterPalette(ROWS, { search: "billund" })).toHaveLength(1)
    expect(filterPalette(ROWS, { search: "r01" })).toHaveLength(1)
    expect(filterPalette(ROWS, { search: "qfx5120-48y" })).toHaveLength(6)
  })

  it("leaves placed devices out of Not placed", () => {
    const placed = new Set(["leaf1", "spine2"])
    expect(
      filterPalette(ROWS, { show: "unplaced", placed }).map((r) => r.id)
    ).toEqual(["leaf2", "pp1", "spine1", "loose"])
    expect(filterPalette(ROWS, { show: "all", placed })).toHaveLength(6)
  })
})

describe("groupPalette", () => {
  it("groups by role in order, devices without a role last", () => {
    const shuffled = [ROWS[5], ...ROWS.slice(0, 5)]
    const groups = groupPalette(shuffled)
    expect(groups.map((g) => g.role?.name ?? null)).toEqual([
      "Leaf",
      "Patch panel",
      "Spine",
      null,
    ])
    expect(groups[0].rows.map((r) => r.id)).toEqual(["leaf1", "leaf2"])
  })
})

describe("DevicePalette", () => {
  it("lists the devices under their roles' coloured badges", async () => {
    renderPalette()
    await screen.findByText("leaf1")
    const header = document.querySelector<HTMLElement>(
      '[data-group="r-spine"]'
    )!
    const badge = within(header).getByText("Spine")
    // The role's own colour, as a pill - never a dot.
    expect(badge.style.backgroundColor).toBe("rgb(124, 58, 237)")
    expect(header.querySelector(".rounded-full")).toBeNull()
    expect(within(header).getByText("2")).toBeTruthy()
    expect(
      within(document.querySelector('[data-group="none"]')!).getByText(
        "No role"
      )
    ).toBeTruthy()
    // Name, then type and site.
    expect(within(row("leaf2")).getByText("QFX5120-48Y · Billund")).toBeTruthy()
  })

  it("folds a role's group", async () => {
    renderPalette()
    await screen.findByText("spine1")
    fireEvent.click(document.querySelector('[data-group="r-spine"]')!)
    expect(screen.queryByText("spine1")).toBeNull()
    expect(screen.getByText("leaf1")).toBeTruthy()
  })

  it("filters as you type", async () => {
    renderPalette()
    await screen.findByText("leaf1")
    fireEvent.change(screen.getByLabelText("Search devices"), {
      target: { value: "spine" },
    })
    await screen.findByText("spine1")
    expect(screen.queryByText("leaf1")).toBeNull()
  })

  it("dims and ticks a device already on the map, and finds its card", async () => {
    const { props } = renderPalette({ placed: new Set(["leaf1"]) })
    await screen.findByText("leaf1")
    const placed = row("leaf1")
    expect(placed.dataset.placed).toBe("true")
    expect(placed.getAttribute("draggable")).toBe("false")
    expect(within(placed).getByLabelText("On the map")).toBeTruthy()
    fireEvent.click(placed)
    expect(props.onFocus).toHaveBeenCalledWith("leaf1")
    // Not placed hides it.
    fireEvent.click(screen.getByRole("button", { name: /Not placed/ }))
    expect(screen.queryByText("leaf1")).toBeNull()
    expect(screen.getByText("leaf2")).toBeTruthy()
  })

  it("drags the device ids with the palette's type", async () => {
    renderPalette()
    await screen.findByText("leaf1")
    const { data, dataTransfer } = dragFrom(row("leaf2"))
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      DEVICE_IDS_MIME,
      JSON.stringify(["leaf2"])
    )
    expect(dataTransfer.effectAllowed).toBe("copy")
    expect(JSON.parse(data.get(DEVICE_IDS_MIME)!)).toEqual(["leaf2"])
    // The drag image names the device.
    expect(dataTransfer.setDragImage).toHaveBeenCalled()
  })

  it("drags a multi-selection, in list order, with its count", async () => {
    renderPalette({ placed: new Set(["spine2"]) })
    await screen.findByText("leaf1")
    fireEvent.click(row("spine1"))
    fireEvent.click(row("leaf1"), { ctrlKey: true })
    // Shift extends from the last click; the placed spine2 is skipped.
    fireEvent.click(row("loose"), { shiftKey: true })
    const { data, dataTransfer } = dragFrom(row("loose"))
    expect(JSON.parse(data.get(DEVICE_IDS_MIME)!)).toEqual([
      "leaf1",
      "leaf2",
      "pp1",
      "spine1",
      "loose",
    ])
    const image = dataTransfer.setDragImage.mock.calls[0][0] as HTMLElement
    expect(image.textContent).toBe("5 devices")
    expect(screen.getByText("selected")).toBeTruthy()
  })

  it("adds on double-click and on Enter", async () => {
    const { props } = renderPalette()
    await screen.findByText("leaf1")
    fireEvent.doubleClick(row("spine1"))
    expect(props.onAdd).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "spine1" }),
    ])
    fireEvent.keyDown(row("leaf2"), { key: "Enter" })
    expect(props.onAdd).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "leaf2" }),
    ])
  })

  it("keeps patch panels back while the map folds them away", async () => {
    const { props } = renderPalette({ panelsHidden: true })
    await screen.findByText("pp1")
    const pp = row("pp1")
    expect(pp.getAttribute("draggable")).toBe("false")
    expect(pp.getAttribute("aria-disabled")).toBe("true")
    fireEvent.doubleClick(pp)
    expect(props.onAdd).not.toHaveBeenCalled()
  })

  it("offers a new view, and no dragging, on a map that follows its filters", async () => {
    const onNewView = vi.fn()
    const { props } = renderPalette({ editable: false, onNewView })
    await screen.findByText("leaf1")
    expect(screen.getByText("Filtered map")).toBeTruthy()
    expect(row("leaf1").getAttribute("draggable")).toBe("false")
    fireEvent.doubleClick(row("leaf1"))
    expect(props.onAdd).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "New view…" }))
    expect(onNewView).toHaveBeenCalled()
  })

  it("windows a long list", async () => {
    const many = Array.from({ length: WINDOW_OVER + 300 }, (_, i) =>
      dev(`d${String(i).padStart(4, "0")}`)
    )
    paletteWith(many)
    renderPalette()
    await screen.findByText("d0000")
    const shown = document.querySelectorAll("[data-device]").length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(100)
    expect(screen.queryByText("d0700")).toBeNull()
  })
})
