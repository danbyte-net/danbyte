// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PointerMenu } from "@/components/pointer-menu"
import {
  DeviceMenuItems,
  GroupMenuItems,
  PaneMenuItems,
  RegionMenuItems,
} from "./context-menu"
import type { CardFace, DeviceMenuProps } from "./context-menu"

afterEach(cleanup)

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
// The router restores the scroll on navigation; jsdom has no layout.
window.scrollTo = () => undefined

/** The items, open at a point, inside a real in-memory router (the device
 * and settings items are router links). */
async function openMenu(items: React.ReactNode, onClose = vi.fn()) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => (
      <PointerMenu menu={{ x: 40, y: 60 }} onClose={onClose} label="Test">
        {() => items}
      </PointerMenu>
    ),
  })
  const devicePage = createRoute({
    getParentRoute: () => root,
    path: "/devices/$id",
    component: () => <p>device page</p>,
  })
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings/topology",
    component: () => <p>settings page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([map, devicePage, settings]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
  })
  render(<RouterProvider router={router as never} />)
  await screen.findByRole("menu")
  return { router, onClose }
}

/** The menu's rows in order: items by their text, separators as "--". */
function rows() {
  const menu = screen.getByRole("menu")
  return [
    ...menu.querySelectorAll(
      "[role=menuitem], [role=menuitemradio], [role=separator]"
    ),
  ]
    .filter((el) => el.getAttribute("role") !== "menuitemradio")
    .map((el) =>
      el.getAttribute("role") === "separator" ? "--" : el.textContent.trim()
    )
}

function device(over: Partial<DeviceMenuProps> = {}): DeviceMenuProps {
  return {
    deviceId: "d1",
    builder: false,
    onFocus: vi.fn(),
    onAddConnected: vi.fn(),
    onRemove: vi.fn(),
    onStartSet: vi.fn(),
    onHide: vi.fn(),
    ...over,
  }
}

const face = (over: Partial<CardFace> = {}): CardFace => ({
  photo: false,
  canPhoto: true,
  anchor: "ports",
  onFace: vi.fn(),
  onAnchor: vi.fn(),
  ...over,
})

describe("DeviceMenuItems", () => {
  it("offers a filtered map's card its items in order", async () => {
    await openMenu(<DeviceMenuItems {...device()} />)
    expect(rows()).toEqual([
      "Open device",
      "Focus",
      "--",
      "Start hand-picked map",
      "HideH",
    ])
  })

  it("adds and removes on a hand-picked map", async () => {
    const p = device({ builder: true })
    await openMenu(<DeviceMenuItems {...p} />)
    expect(rows()).toEqual([
      "Open device",
      "Focus",
      "--",
      "Add connected devices",
      "Remove from mapDel",
      "HideH",
    ])
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from map/ }))
    expect(p.onRemove).toHaveBeenCalledOnce()
  })

  it("opens the device page as a router link", async () => {
    const { router, onClose } = await openMenu(
      <DeviceMenuItems {...device()} />
    )
    const open = screen.getByRole("menuitem", { name: "Open device" })
    expect(open.tagName).toBe("A")
    expect(open.getAttribute("href")).toBe("/devices/d1")
    expect(open.querySelector("svg.lucide-arrow-up-right")).not.toBeNull()
    fireEvent.click(open)
    expect(await screen.findByText("device page")).toBeTruthy()
    expect(router.state.location.pathname).toBe("/devices/d1")
    expect(onClose).toHaveBeenCalled()
  })

  it("reuses the toolbar's icons and shows the Hide key", async () => {
    await openMenu(<DeviceMenuItems {...device({ builder: true })} />)
    const icon = (name: RegExp | string) =>
      screen
        .getByRole("menuitem", { name })
        .querySelector("svg")
        ?.getAttribute("class")
    expect(icon("Focus")).toContain("lucide-crosshair")
    expect(icon("Add connected devices")).toContain("lucide-cable")
    expect(icon(/^Hide/)).toContain("lucide-eye-off")
    const hide = screen.getByRole("menuitem", { name: /^Hide/ })
    expect(
      hide.querySelector("[data-slot=dropdown-menu-shortcut]")?.textContent
    ).toBe("H")
    // Items with no toolbar twin line up with the icons.
    expect(
      screen
        .getByRole("menuitem", { name: /Remove from map/ })
        .getAttribute("data-inset")
    ).toBe("true")
  })

  it("runs Focus, Hide and Start hand-picked map", async () => {
    const p = device()
    await openMenu(<DeviceMenuItems {...p} />)
    fireEvent.click(screen.getByRole("menuitem", { name: "Focus" }))
    expect(p.onFocus).toHaveBeenCalledOnce()
    cleanup()
    const q = device()
    await openMenu(<DeviceMenuItems {...q} />)
    fireEvent.click(screen.getByRole("menuitem", { name: /^Hide/ }))
    expect(q.onHide).toHaveBeenCalledOnce()
    cleanup()
    const r = device()
    await openMenu(<DeviceMenuItems {...r} />)
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Start hand-picked map" })
    )
    expect(r.onStartSet).toHaveBeenCalledOnce()
  })

  it("gives a card with no device only Hide", async () => {
    await openMenu(<DeviceMenuItems {...device({ deviceId: null })} />)
    expect(rows()).toEqual(["HideH"])
  })

  it("adds the Diagram's card items after a separator", async () => {
    await openMenu(
      <DeviceMenuItems
        {...device({
          diagram: {
            face: face(),
            onCardLines: vi.fn(),
            roleSlug: "core",
          },
        })}
      />
    )
    expect(rows().slice(5)).toEqual([
      "--",
      "Show photo",
      "Card lines…",
      "Role card lines",
    ])
    expect(
      screen
        .getByRole("menuitem", { name: "Role card lines" })
        .getAttribute("href")
    ).toBe("/settings/topology?role=core")
  })

  it("names the face items for what a pick switches to", async () => {
    const f = face({ photo: true, anchor: "edge" })
    await openMenu(<DeviceMenuItems {...device({ diagram: { face: f } })} />)
    expect(rows().slice(5)).toEqual(["--", "Show card", "Cables to ports"])
    fireEvent.click(screen.getByRole("menuitem", { name: "Cables to ports" }))
    expect(f.onAnchor).toHaveBeenCalledOnce()
  })

  it("disables Show photo for a type with none, and says why", async () => {
    const f = face({ canPhoto: false })
    await openMenu(<DeviceMenuItems {...device({ diagram: { face: f } })} />)
    const item = screen.getByRole("menuitem", { name: "Show photo" })
    expect(item.getAttribute("aria-disabled")).toBe("true")
    fireEvent.focus(item.parentElement!)
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "No photo for this type"
    )
    expect(f.onFace).not.toHaveBeenCalled()
  })

  it("leaves the Diagram items out without a device", async () => {
    await openMenu(
      <DeviceMenuItems
        {...device({ deviceId: null, diagram: { face: face() } })}
      />
    )
    expect(rows()).toEqual(["HideH"])
  })
})

describe("GroupMenuItems", () => {
  it("opens the group on this map, or hides it", async () => {
    const onOpen = vi.fn()
    const onHide = vi.fn()
    await openMenu(<GroupMenuItems onOpen={onOpen} onHide={onHide} />)
    expect(rows()).toEqual(["Open group", "HideH"])
    // Drilling in stays on the map: no leave-the-page arrow.
    expect(
      screen.getByRole("menuitem", { name: "Open group" }).querySelector("svg")
    ).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Open group" }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe("RegionMenuItems", () => {
  const region = (kind: "band" | "zone", color: string | null) => {
    const p = {
      kind,
      color,
      onRename: vi.fn(),
      onRecolor: vi.fn(),
      onDelete: vi.fn(),
    }
    return p
  }

  it("renames, colors and deletes, in that order", async () => {
    await openMenu(<RegionMenuItems {...region("zone", "#0ea5e9")} />)
    expect(rows()).toEqual(["Rename", "--", "Delete"])
    const swatches = screen
      .getAllByRole("menuitemradio")
      .map((s) => s.getAttribute("aria-label"))
    expect(swatches).toEqual([
      "Slate",
      "Sky",
      "Emerald",
      "Amber",
      "Pink",
      "Violet",
    ])
  })

  it("gives a band a Neutral swatch first", async () => {
    await openMenu(<RegionMenuItems {...region("band", null)} />)
    const swatches = screen.getAllByRole("menuitemradio")
    expect(swatches[0].getAttribute("aria-label")).toBe("Neutral")
    expect(swatches).toHaveLength(7)
    expect(swatches[0].getAttribute("aria-checked")).toBe("true")
  })

  it("marks the current color and recolors by name", async () => {
    const p = region("zone", "#0ea5e9")
    await openMenu(<RegionMenuItems {...p} />)
    expect(
      screen
        .getByRole("menuitemradio", { name: "Sky" })
        .getAttribute("aria-checked")
    ).toBe("true")
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Violet" }))
    expect(p.onRecolor).toHaveBeenCalledWith("#8b5cf6")
  })

  it("names a swatch on hover", async () => {
    await openMenu(<RegionMenuItems {...region("zone", null)} />)
    fireEvent.focus(screen.getByRole("menuitemradio", { name: "Amber" }))
    expect((await screen.findByRole("tooltip")).textContent).toBe("Amber")
  })

  it("draws Delete as the destructive item", async () => {
    const p = region("band", null)
    await openMenu(<RegionMenuItems {...p} />)
    const del = screen.getByRole("menuitem", { name: "Delete" })
    expect(del.getAttribute("data-variant")).toBe("destructive")
    expect(del.querySelector("svg.lucide-trash-2")).not.toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
    expect(p.onRename).toHaveBeenCalledOnce()
  })
})

describe("PaneMenuItems", () => {
  const pane = (
    over: Partial<React.ComponentProps<typeof PaneMenuItems>> = {}
  ) => ({
    tab: "diagram" as const,
    builder: false,
    notesFull: false,
    onAddDevices: vi.fn(),
    onAddBand: vi.fn(),
    onAddZone: vi.fn(),
    onAddText: vi.fn(),
    onBackToFiltered: vi.fn(),
    ...over,
  })

  it("adds devices, a band, a zone and text on the Diagram", async () => {
    await openMenu(<PaneMenuItems {...pane()} />)
    expect(rows()).toEqual(["Add devices…", "Add band", "Add zone", "Add text"])
  })

  it("adds one device or a zone on Hierarchy", async () => {
    await openMenu(<PaneMenuItems {...pane({ tab: "hierarchy" })} />)
    expect(rows()).toEqual(["Add device…", "Add zone"])
  })

  it("goes back to the filtered map from a hand-picked one", async () => {
    const p = pane({ builder: true })
    await openMenu(<PaneMenuItems {...p} />)
    expect(rows().slice(-2)).toEqual(["--", "Back to filtered map"])
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Back to filtered map" })
    )
    expect(p.onBackToFiltered).toHaveBeenCalledOnce()
  })

  it("disables Add text once the map holds all the notes it can", async () => {
    const p = pane({ notesFull: true })
    await openMenu(<PaneMenuItems {...p} />)
    expect(
      screen
        .getByRole("menuitem", { name: "Add text" })
        .getAttribute("aria-disabled")
    ).toBe("true")
  })
})

describe("PointerMenu", () => {
  it("closes on Escape", async () => {
    const { onClose } = await openMenu(
      <PaneMenuItems
        tab="diagram"
        builder={false}
        notesFull={false}
        onAddDevices={vi.fn()}
        onAddBand={vi.fn()}
        onAddZone={vi.fn()}
        onAddText={vi.fn()}
        onBackToFiltered={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("keeps the browser's own menu shut while it is open", async () => {
    await openMenu(<GroupMenuItems onOpen={vi.fn()} onHide={vi.fn()} />)
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })
    document.body.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it("names the menu", async () => {
    await openMenu(<GroupMenuItems onOpen={vi.fn()} onHide={vi.fn()} />)
    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe("Test")
  })
})
