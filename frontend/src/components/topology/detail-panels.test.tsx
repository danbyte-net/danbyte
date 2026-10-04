// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { TopoEdge, TopoNode } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  BundlePanel,
  EdgePanel,
  GroupEdgePanel,
  GroupPanel,
  NodePanel,
} from "./detail-panels"

// The topology's detail panels share one layout: a title and a Close button,
// key/value rows, labelled sections, and "Open X" first in the footer. No
// status, role or type is ever a coloured dot beside a name.

const apiMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
window.scrollTo = () => undefined

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((url: string) => {
    if (url === "/api/dcim/choices/")
      return Promise.resolve({
        cable_types: [
          { value: "cat6", label: "CAT6" },
          { value: "smf-os2", label: "Singlemode fiber (OS2)" },
        ],
      })
    if (url === "/api/monitoring/status/")
      return Promise.resolve({ statuses: { d1: { status: "degraded" } } })
    return Promise.resolve({})
  })
})
afterEach(cleanup)

/** The panel inside a real in-memory router (its Open links are router
 * links), with a query client for its lookups. */
async function show(panel: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => <>{panel}</>,
  })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/$kind/$id",
    component: () => <p>object page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([map, page]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  const aside = await screen.findByRole("complementary")
  return { router, aside }
}

const ok = { id: "s1", name: "Active", color: "22c55e", text_color: "#fff" }

function device(over: Partial<TopoNode["data"]> = {}): TopoNode["data"] {
  return {
    name: "core-sw-01",
    device_id: "d1",
    role: { name: "Spine", color: "6366f1" },
    status_mini: ok,
    device_type: "QFX5120",
    site: "Aarhus",
    location: "Hall A",
    primary_ip: "10.0.0.1/24",
    interface_count: 48,
    ports: [
      { name: "et-0/0/1" },
      { name: "et-0/0/2" },
      { name: "et-0/0/3" },
    ] as TopoNode["data"]["ports"],
    ...over,
  }
}

/** The label/value rows, in order. */
function rowsOf(el: HTMLElement) {
  return [...el.querySelectorAll(".justify-between")].map((r) =>
    [...r.children].map((c) => c.textContent)
  )
}

function expectNoDots(el: HTMLElement) {
  expect(el.querySelector(".rounded-full")).toBeNull()
  expect(el.className).not.toMatch(/shadow/)
}

describe("NodePanel", () => {
  it("lays out a device: badges, rows, Open device then Focus", async () => {
    const onFocus = vi.fn()
    const { aside, router } = await show(
      <NodePanel
        data={device()}
        monitor="down"
        onClose={() => {}}
        onFocus={onFocus}
      />
    )
    expect(aside.getAttribute("aria-label")).toBe("Device")
    // The device's name is a name, not an identifier: sans.
    const title = within(aside).getByText("core-sw-01")
    expect(title.closest(".font-mono")).toBeNull()
    expect(rowsOf(aside)).toEqual([
      ["Role", "Spine"],
      ["Status", "Active"],
      ["Monitoring", "Down"],
      ["Type", "QFX5120"],
      ["Site", "Aarhus · Hall A"],
      ["IP", "10.0.0.1/24"],
      ["Cabled", "3 / 48"],
    ])
    expectNoDots(aside)
    // The map already knew the check state: nothing fetched.
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/monitoring/status/",
      expect.anything()
    )

    const actions = aside.querySelectorAll("a, button:not([aria-label=Close])")
    expect([...actions].map((a) => a.textContent.trim())).toEqual([
      "Open device",
      "Focus",
    ])
    fireEvent.click(within(aside).getByRole("button", { name: "Focus" }))
    expect(onFocus).toHaveBeenCalledWith("d1")
    const open = within(aside).getByRole("link", { name: "Open device" })
    expect(open.getAttribute("href")).toBe("/devices/d1")
    expect(open.querySelector("svg")).not.toBeNull()
    fireEvent.click(open)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/devices/d1")
    )
  })

  it("leaves out a missing status, and asks for the check state it lacks", async () => {
    const { aside } = await show(
      <NodePanel
        data={device({ status_mini: null, location: null })}
        onClose={() => {}}
        onFocus={() => {}}
      />
    )
    await within(aside).findByText("Degraded")
    const labels = rowsOf(aside).map((r) => r[0])
    expect(labels).not.toContain("Status")
    expect(rowsOf(aside)).toContainEqual(["Site", "Aarhus"])
    expect(apiMock).toHaveBeenCalledWith("/api/monitoring/status/", {
      method: "POST",
      body: JSON.stringify({ devices: ["d1"] }),
    })
  })

  it("shows no Monitoring row for a device without checks", async () => {
    const { aside } = await show(
      <NodePanel
        data={device()}
        monitor={null}
        onClose={() => {}}
        onFocus={() => {}}
      />
    )
    expect(rowsOf(aside).map((r) => r[0])).not.toContain("Monitoring")
  })

  it("closes from a ghost icon button with a tooltip", async () => {
    const onClose = vi.fn()
    const { aside } = await show(
      <NodePanel
        data={device()}
        monitor={null}
        onClose={onClose}
        onFocus={() => {}}
      />
    )
    const close = within(aside).getByRole("button", { name: "Close" })
    expect(close.getAttribute("data-size")).toBe("icon-xs")
    expect(close.getAttribute("title")).toBeNull()
    fireEvent.focus(close)
    expect(
      (await screen.findByRole("tooltip")).textContent.includes("Close")
    ).toBe(true)
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalled()
  })
})

const cable = (
  over: Partial<NonNullable<TopoEdge["data"]>> = {}
): NonNullable<TopoEdge["data"]> => ({
  cable_id: "c7",
  cable_numid: 7,
  cable_type: "cat6",
  status_mini: ok,
  length: "3.00",
  length_unit: "m",
  speed: "10G",
  pairs: [
    {
      a: "core-sw-01:et-0/0/1",
      b: "leaf-02:et-0/0/49",
      a_port: "et-0/0/1",
      b_port: "et-0/0/49",
    },
  ],
  ...over,
})

describe("EdgePanel", () => {
  it("names the cable type in words and lists the ports", async () => {
    const { aside } = await show(
      <EdgePanel data={cable()} onClose={() => {}} line={<p>line tabs</p>} />
    )
    expect(aside.getAttribute("aria-label")).toBe("Cable")
    expect(within(aside).getByText("#7").className).toContain("font-mono")
    await within(aside).findByText("CAT6")
    expect(rowsOf(aside)).toEqual([
      ["Type", "CAT6"],
      ["Status", "Active"],
      ["Length", "3.00 m"],
      ["Speed", "10G"],
    ])
    expectNoDots(aside)
    // Sections in order, each under the one shared label.
    const sections = within(aside).getAllByRole("region")
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Line",
      "Ports",
    ])
    expect(within(sections[1]).getByText("core-sw-01:et-0/0/1")).toBeTruthy()
    expect(
      within(aside)
        .getByRole("link", { name: "Open cable" })
        .getAttribute("href")
    ).toBe("/cables/c7")
  })

  it("leaves out a missing status and uses the cable's own label", async () => {
    const { aside } = await show(
      <EdgePanel
        data={cable({ status_mini: null, cable_label: "Uplink A" })}
        onClose={() => {}}
      />
    )
    expect(within(aside).getByText("Uplink A")).toBeTruthy()
    expect(rowsOf(aside).map((r) => r[0])).not.toContain("Status")
    expect(within(aside).queryByRole("region", { name: "Line" })).toBeNull()
  })
})

describe("BundlePanel", () => {
  const member = (n: number, lag = false) =>
    cable({
      cable_id: `c${n}`,
      cable_numid: n,
      status_mini: null,
      pairs: [
        {
          a: `core-sw-01:et-0/0/${n}`,
          b: `leaf-02:et-0/0/${n}`,
          a_port: `et-0/0/${n}`,
          b_port: `et-0/0/${n}`,
        },
      ],
      lag: lag
        ? { a: { id: "l1", name: "ae0" }, b: { id: "l2", name: "ae1" } }
        : undefined,
    })

  it("titles a LAG by its aggregates and lists each cable with Open", async () => {
    const { aside } = await show(
      <BundlePanel
        cables={[member(1, true), member(2, true)]}
        onClose={() => {}}
      />
    )
    expect(aside.textContent).toContain("ae0 ⇄ ae1 · 2 cables")
    expect(within(aside).getByText("ae0 ⇄ ae1").className).toContain(
      "font-mono"
    )
    const list = within(aside).getByRole("region", { name: "Cables" })
    const open = within(list).getAllByRole("link")
    expect(open.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Open Cable #1",
      "Open Cable #2",
    ])
    expect(open[0].textContent.trim()).toBe("Open")
    expect(open[0].getAttribute("data-size")).toBe("xs")
    expect(open[0].getAttribute("href")).toBe("/cables/c1")
    await within(list).findAllByText("CAT6 · 10G")
    expectNoDots(aside)
  })

  it("titles plain parallel cables by their two devices", async () => {
    const { aside } = await show(
      <BundlePanel cables={[member(1), member(2)]} onClose={() => {}} />
    )
    expect(aside.textContent).toContain("core-sw-01 ↔ leaf-02 · 2 cables")
  })
})

describe("GroupPanel", () => {
  it("says what it is grouped by and drills in without an arrow", async () => {
    const onDrill = vi.fn()
    const data = {
      group_id: "loc1",
      kind: "location" as const,
      name: "Hall A",
      device_count: 12,
      roles: [
        { name: "Spine", color: "6366f1", count: 2 },
        { name: "Leaf", color: "", count: 10 },
      ],
    }
    const { aside } = await show(
      <GroupPanel data={data} onClose={() => {}} onDrill={onDrill} />
    )
    expect(aside.getAttribute("aria-label")).toBe("Location")
    expect(rowsOf(aside)).toEqual([
      ["Grouped by", "Location"],
      ["Devices", "12"],
    ])
    const roles = within(aside).getByRole("region", { name: "Roles" })
    expect([...roles.children].slice(1).map((r) => r.textContent)).toEqual([
      "Spine2",
      "Leaf10",
    ])
    expect(within(roles).getByText("Spine").getAttribute("data-slot")).toBe(
      "badge"
    )
    expectNoDots(aside)
    const open = within(aside).getByRole("button", { name: "Open group" })
    expect(open.querySelector("svg")).toBeNull()
    fireEvent.click(open)
    expect(onDrill).toHaveBeenCalledWith(data)
  })
})

describe("GroupEdgePanel", () => {
  it("lists the cable types in words", async () => {
    const { aside } = await show(
      <GroupEdgePanel
        data={{ cable_count: 2, types: ["cat6", "smf-os2"] }}
        onClose={() => {}}
      />
    )
    expect(within(aside).getByText("2 cables")).toBeTruthy()
    const types = within(aside).getByRole("region", { name: "Cable types" })
    await within(types).findByText("Singlemode fiber (OS2)")
    expect(within(types).getByText("CAT6")).toBeTruthy()
    expectNoDots(aside)
  })

  it("says so when no cable has a type", async () => {
    const { aside } = await show(
      <GroupEdgePanel data={{ cable_count: 1, types: [] }} onClose={() => {}} />
    )
    expect(within(aside).getByText("1 cable")).toBeTruthy()
    expect(within(aside).getByText("No cable types")).toBeTruthy()
  })
})
