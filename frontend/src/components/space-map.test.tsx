// @vitest-environment jsdom
import { useState } from "react"
import type { ComponentProps, ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SpaceMap as SpaceMapData, SpaceMapCell } from "@/lib/api"
import { SpaceMap } from "./space-map"

const { apiMock, navMock, zoomMock, prefs } = vi.hoisted(() => {
  const values: Record<string, unknown> = {}
  return {
    apiMock: vi.fn<(path: string) => Promise<unknown>>(),
    navMock: vi.fn(),
    zoomMock: vi.fn<(zoom: string[]) => void>(),
    prefs: { values },
  }
})
vi.mock("@/lib/api", () => ({ api: apiMock }))
vi.mock("@/lib/use-user-prefs", () => ({ useUserPrefs: () => prefs }))
vi.mock("@tanstack/react-router", () => ({
  // A plain anchor that keeps every prop Radix's Slot merges in (role,
  // handlers, ref) so menu items and tooltips behave as in the app.
  Link: ({
    children,
    params,
    to: _to,
    ...rest
  }: {
    children?: ReactNode
    params?: { id: string }
    to?: string
  }) => (
    <a href={`/prefixes/${params?.id ?? ""}`} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => navMock,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

function cell(over: Partial<SpaceMapCell> & { cidr: string }): SpaceMapCell {
  return {
    state: "free",
    used: false,
    exact: false,
    dirty: false,
    ip_count: 0,
    overlap_with: [],
    overlap_count: 0,
    used_fraction: 0,
    used_spans: [],
    range_count: 0,
    ranges: [],
    range_spans: [],
    ...over,
  }
}

function map(
  root: string,
  cells: SpaceMapCell[],
  prefixlen: number,
  context: SpaceMapData["context"] = null
): SpaceMapData {
  return {
    supported: true,
    root,
    context,
    subnet_details: null,
    next_available: [],
    rows: [
      {
        prefixlen,
        count: cells.length,
        free_count: cells.filter((c) => c.state === "free").length,
        partial_count: cells.filter((c) => c.state === "partial").length,
        dirty_count: 0,
        ranged_count: cells.filter((c) => c.range_count > 0).length,
        cells,
      },
    ],
  }
}

// The /18 overview row with the partly used /26, and what zooming into it
// returns: the /28 that is taken and its free siblings.
const overview = map(
  "10.196.192.0/18",
  [
    cell({ cidr: "10.196.238.64/26" }),
    cell({
      cidr: "10.196.238.128/26",
      state: "partial",
      used: true,
      overlap_with: ["10.196.238.128/28"],
      overlap_count: 1,
      used_fraction: 0.25,
      used_spans: [[0, 0.25, 1]],
      prefix_id: "p28",
    }),
    cell({
      cidr: "10.196.255.192/26",
      state: "partial",
      used: true,
      overlap_with: ["10.196.255.255/32"],
      overlap_count: 1,
      used_fraction: 1 / 64,
      used_spans: [[63 / 64, 1, 1]],
      prefix_id: "h1",
    }),
    cell({
      cidr: "10.196.200.0/26",
      state: "full",
      used: true,
      overlap_with: ["10.196.200.0/24"],
      overlap_count: 1,
      used_fraction: 1,
      used_spans: [[0, 1, 1]],
      prefix_id: "p24",
    }),
  ],
  26
)
const zoomed = map(
  "10.196.238.128/26",
  [
    cell({
      cidr: "10.196.238.128/28",
      state: "full",
      used: true,
      exact: true,
      overlap_with: ["10.196.238.128/28"],
      overlap_count: 1,
      used_fraction: 1,
      used_spans: [[0, 1, 1]],
      prefix_id: "p28",
    }),
    cell({ cidr: "10.196.238.144/28" }),
    cell({ cidr: "10.196.238.160/28" }),
    cell({ cidr: "10.196.238.176/28" }),
  ],
  28
)

function within(path: string): string | null {
  return new URLSearchParams(path.split("?")[1] ?? "").get("within")
}

type Extra = Partial<ComponentProps<typeof SpaceMap>> & {
  initialZoom?: string[]
}

// The prefix page keeps the zoom path in the URL; here it is plain state.
function Harness({ initialZoom = [], ...rest }: Extra) {
  const [zoom, setZoom] = useState<string[]>(initialZoom)
  return (
    <SpaceMap
      prefixId="p18"
      rootCidr="10.196.192.0/18"
      zoom={zoom}
      onZoomChange={(next) => {
        zoomMock(next)
        setZoom(next)
      }}
      {...rest}
    />
  )
}

function renderMap(rootCidr = "10.196.192.0/18", extra: Extra = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Harness rootCidr={rootCidr} {...extra} />
    </QueryClientProvider>
  )
}

/** Radix menus open from the keyboard - Enter on the trigger. */
function openMenu(el: HTMLElement) {
  fireEvent.keyDown(el, { key: "Enter" })
}

describe("SpaceMap", () => {
  beforeEach(() => {
    prefs.values = {}
    navMock.mockReset()
    zoomMock.mockReset()
    apiMock.mockReset()
    apiMock.mockImplementation((path: string) => {
      const w = within(path)
      if (w === "10.196.238.128/26") return Promise.resolve(zoomed)
      if (w === "10.196.200.0/26")
        return Promise.resolve(
          map("10.196.200.0/26", [cell({ cidr: "10.196.200.0/27" })], 27, {
            id: "p24",
            cidr: "10.196.200.0/24",
          })
        )
      return Promise.resolve(overview)
    })
  })
  afterEach(cleanup)

  it("draws a partly used block with the used part where the child sits", async () => {
    renderMap()
    const block = await screen.findByRole("button", {
      name: /^10\.196\.238\.128\/26, 25% used/,
    })
    const bar = block.querySelector<HTMLElement>("[data-slot=used-span]")
    expect(bar).not.toBeNull()
    expect(bar!.style.left).toBe("0%")
    expect(bar!.style.width).toBe("25%")
    expect(bar!.style.minWidth).toBe("3px")
    // A sliver at the end of a block hangs off the right edge, so its 3px
    // floor grows inward instead of being clipped.
    const tail = screen
      .getByRole("button", { name: /^10\.196\.255\.192\/26/ })
      .querySelector<HTMLElement>("[data-slot=used-span]")!
    expect(tail.style.right).toBe("0%")
    expect(tail.style.left).toBe("")
    // A fully used block has no split - it is solid.
    const full = screen.getByRole("button", { name: /^10\.196\.200\.0\/26/ })
    expect(full.querySelector("[data-slot=used-span]")).toBeNull()
  })

  it("zooms into a partly used block on click instead of opening the child", async () => {
    renderMap()
    fireEvent.click(
      await screen.findByRole("button", { name: /^10\.196\.238\.128\/26/ })
    )
    await waitFor(() =>
      expect(within(apiMock.mock.calls.at(-1)![0])).toBe("10.196.238.128/26")
    )
    expect(navMock).not.toHaveBeenCalled()
    // The taken /28 and its free siblings are now cells.
    const taken = await screen.findByRole("button", {
      name: /^10\.196\.238\.128\/28, Existing prefix/,
    })
    expect(
      screen.getByRole("button", { name: /^10\.196\.238\.144\/28, Free/ })
    ).toBeTruthy()
    // The /28 itself opens from its menu, and can be zoomed further.
    openMenu(taken)
    const open = await screen.findByRole("menuitem", {
      name: /Open 10\.196\.238\.128\/28/,
    })
    expect(open.getAttribute("href")).toBe("/prefixes/p28")
    expect(
      screen.getByRole("menuitem", { name: /Zoom into 10\.196\.238\.128\/28/ })
    ).toBeTruthy()
  })

  it("zooms back out from the trail", async () => {
    renderMap()
    fireEvent.click(
      await screen.findByRole("button", { name: /^10\.196\.238\.128\/26/ })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Zoom out" }))
    await screen.findByRole("button", { name: /^10\.196\.238\.128\/26/ })
    expect(within(apiMock.mock.calls.at(-1)![0])).toBeNull()
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull()
  })

  it("keeps focus in the map after a keyboard zoom", async () => {
    renderMap()
    const block = await screen.findByRole("button", {
      name: /^10\.196\.238\.128\/26/,
    })
    block.focus()
    fireEvent.click(block)
    await screen.findByRole("button", { name: /^10\.196\.238\.144\/28/ })
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Space map of 10.196.238.128/26" })
    )
  })

  it("offers open and zoom on a block inside a child prefix, and registers IPs there", async () => {
    renderMap()
    const inside = await screen.findByRole("button", {
      name: /^10\.196\.200\.0\/26, In 10\.196\.200\.0\/24/,
    })
    openMenu(inside)
    const open = await screen.findByRole("menuitem", {
      name: /Open 10\.196\.200\.0\/24/,
    })
    expect(open.getAttribute("href")).toBe("/prefixes/p24")
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Zoom into 10\.196\.200\.0\/26/ })
    )
    // The trail names the prefix the view sits in.
    const holder = await screen.findByRole("link", { name: "10.196.200.0/24" })
    expect(holder.getAttribute("href")).toBe("/prefixes/p24")
    // A free cell in there registers its IP under that prefix, not the /18.
    openMenu(
      await screen.findByRole("button", { name: /^10\.196\.200\.0\/27/ })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Register an IP here/ })
    )
    expect(navMock).toHaveBeenCalledWith({
      to: "/ips/new",
      search: { address: "10.196.200.0", prefix: "p24" },
    })
  })

  it("asks for the depth the user set", async () => {
    prefs.values = { space_map_v4_max: 29, space_map_v6_max: 64 }
    renderMap()
    await screen.findByRole("button", { name: /^10\.196\.238\.128\/26/ })
    const q = new URLSearchParams(apiMock.mock.calls[0][0].split("?")[1])
    expect(q.get("v4_max")).toBe("29")
    expect(q.get("v6_max")).toBe("64")
  })

  it("zooms into a partly used IPv6 block the same way", async () => {
    apiMock.mockImplementation((path: string) =>
      Promise.resolve(
        within(path) === "2001:db8:0:100::/56"
          ? map(
              "2001:db8:0:100::/56",
              [cell({ cidr: "2001:db8:0:100::/60" })],
              60
            )
          : map(
              "2001:db8::/48",
              [
                cell({
                  cidr: "2001:db8:0:100::/56",
                  state: "partial",
                  used: true,
                  overlap_with: ["2001:db8:0:140::/64"],
                  overlap_count: 1,
                  used_fraction: 1 / 256,
                  used_spans: [[0.25, 0.25390625, 1]],
                  prefix_id: "v6",
                }),
              ],
              56
            )
      )
    )
    renderMap("2001:db8::/48")
    const block = await screen.findByRole("button", {
      name: /^2001:db8:0:100::\/56, <1% used/,
    })
    fireEvent.click(block)
    await screen.findByRole("button", { name: /^2001:db8:0:100::\/60/ })
    expect(within(apiMock.mock.calls.at(-1)![0])).toBe("2001:db8:0:100::/56")
  })

  it("reports each zoom as a path and restores a zoomed view from one", async () => {
    renderMap()
    fireEvent.click(
      await screen.findByRole("button", { name: /^10\.196\.238\.128\/26/ })
    )
    expect(zoomMock).toHaveBeenLastCalledWith(["10.196.238.128/26"])
    cleanup()
    apiMock.mockClear()
    // A reload (or Back) hands the same path in: the zoomed view, no clicks.
    renderMap("10.196.192.0/18", { initialZoom: ["10.196.238.128/26"] })
    await screen.findByRole("button", { name: /^10\.196\.238\.144\/28/ })
    expect(within(apiMock.mock.calls[0][0])).toBe("10.196.238.128/26")
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy()
  })

  it("asks for the rows only - the details live on the Overview", async () => {
    renderMap()
    await screen.findByRole("button", { name: /^10\.196\.238\.128\/26/ })
    const q = new URLSearchParams(apiMock.mock.calls[0][0].split("?")[1])
    expect(q.get("details")).toBe("0")
  })

  it("zooms a free block on click when the user can't add to it", async () => {
    renderMap("10.196.192.0/18", { canAddPrefix: false, canAddIp: false })
    fireEvent.click(
      await screen.findByRole("button", { name: /^10\.196\.238\.64\/26, Free/ })
    )
    expect(zoomMock).toHaveBeenLastCalledWith(["10.196.238.64/26"])
    expect(screen.queryByRole("menuitem")).toBeNull()
  })

  it("sends the create forms back to the map", async () => {
    renderMap("10.196.192.0/18", { returnTo: "/prefixes/p18?tab=map" })
    openMenu(
      await screen.findByRole("button", { name: /^10\.196\.238\.64\/26/ })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /New child prefix here/ })
    )
    expect(navMock).toHaveBeenCalledWith({
      to: "/prefixes/new",
      search: {
        cidr: "10.196.238.64/26",
        vrf: undefined,
        site: undefined,
        location: undefined,
        from: "/prefixes/p18?tab=map",
      },
    })
  })

  it("marks an IP range in a free block and names it", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve(
        map(
          "10.196.192.0/18",
          [
            cell({
              cidr: "10.196.196.0/26",
              range_count: 1,
              ranges: ["10.196.196.10–50"],
              range_spans: [[10 / 64, 51 / 64, 1]],
            }),
          ],
          26
        )
      )
    )
    renderMap()
    const block = await screen.findByRole("button", {
      name: "10.196.196.0/26, Free · range 10.196.196.10–50",
    })
    const strip = block.querySelector<HTMLElement>("[data-slot=range-span]")!
    expect(strip.style.left).toBe(`${(10 / 64) * 100}%`)
    expect(screen.getByText(/holds an IP range/)).toBeTruthy()
  })

  it("draws a span that holds free gaps fainter than a solid one", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve(
        map(
          "11.0.0.0/8",
          [
            cell({
              cidr: "11.0.0.0/9",
              state: "partial",
              used: true,
              overlap_with: ["11.0.0.0/24"],
              overlap_count: 45,
              used_fraction: 0.0008,
              used_spans: [
                [0, 0.0625, 0.001],
                [0.5, 0.5001, 1],
              ],
              prefix_id: "x",
            }),
          ],
          9
        )
      )
    )
    renderMap("11.0.0.0/8")
    const block = await screen.findByRole("button", { name: /^11\.0\.0\.0\/9/ })
    const [faint, solid] = block.querySelectorAll<HTMLElement>(
      "[data-slot=used-span]"
    )
    expect(Number(faint.style.opacity)).toBeLessThan(0.5)
    expect(solid.style.opacity).toBe("")
  })
})
