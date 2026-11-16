// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { ApiError } from "@/lib/api"
import type { FacePort, FacePorts, Interface, Paginated } from "@/lib/api"
import { FaceplateView } from "./device-faceplate"

// The device menus the 3D model viewer opens on a right-click - connect,
// trace, reserve, mark; install, replace, remove - open on the photo
// faceplate too: on an interface marker, a power or console port, and a
// module bay. A left-click keeps what it did, and each item shows only to a
// user who may do it.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  perms: { value: new Set<string>() },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (type: string, action: string) =>
      perms.value.has(`${type}.${action}`),
    faceplateMarkedLit: false,
    faceplatePortLabels: "",
    faceplatePortLabelColor: "#ffffff",
    faceplateGroupLabels: false,
  }),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))
vi.mock("@tanstack/react-router", async (orig) => {
  type LinkProps = {
    children?: React.ReactNode
    to: string
    params?: Record<string, string>
    search?: unknown
  }
  const href = (to: string, params?: Record<string, string>) =>
    Object.entries(params ?? {}).reduce(
      (path, [k, v]) => path.replace(`$${k}`, v),
      to
    )
  return {
    ...(await orig<object>()),
    useNavigate: () => vi.fn(),
    useRouterState: ({ select }: { select?: (s: unknown) => unknown } = {}) => {
      const state = { location: { pathname: "/", search: {}, href: "/" } }
      return select ? select(state) : state
    },
    Link: ({ children, to, params, search: _search, ...rest }: LinkProps) => (
      <a href={href(to, params)} {...rest}>
        {children}
      </a>
    ),
  }
})

const page = <T,>(results: T[]): Paginated<T> => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const fp = (over: Partial<FacePort>): FacePort => ({
  marker: "",
  name: "",
  kind: null,
  id: null,
  connected: false,
  cable_id: null,
  cable_state: "free",
  enabled: true,
  speed: "",
  type: "",
  status: null,
  module: null,
  drift: null,
  ...over,
})

const FACE: FacePorts = {
  front: [
    fp({ marker: "PSU1", name: "PSU1", kind: "power_port", id: "pp1" }),
    fp({ marker: "Slot 1", name: "Slot 1", id: "bay1" }),
  ],
  rear: [],
}

const iface = (over: Partial<Interface> = {}) =>
  ({
    id: "if1",
    name: "eth1",
    device: { id: "d1", name: "sw-1" },
    type: "1000base-t",
    type_display: "1000BASE-T",
    speed: "1G",
    enabled: true,
    mode: "",
    vlan: null,
    tagged_vlans: [],
    mark_connected: false,
    reservation: null,
    cable: null,
    label_color: "",
    ...over,
  }) as unknown as Interface

const marker = (kind: string, name: string, x: number) => ({
  kind,
  name,
  x,
  y: 0.5,
  w: 0.05,
  h: 0.3,
})

const ROUTES: Record<string, unknown> = {
  "/api/device-types/t-sw/": {
    id: "t-sw",
    name: "Switch",
    u_height: 1,
    front_image: "/media/sw-front.png",
    rear_image: null,
    faceplate: null,
    image_ports: {
      front: [
        marker("interface", "eth1", 0.2),
        marker("power-port", "PSU1", 0.5),
        marker("module-bay", "Slot 1", 0.8),
      ],
      rear: [],
    },
  },
  "/api/module-bays/?device=d1": page([
    {
      id: "bay1",
      device: { id: "d1", name: "sw-1" },
      name: "Slot 1",
      position: "1",
      description: "",
      module: null,
      tags: [],
    },
  ]),
}

beforeEach(() => {
  perms.value = new Set()
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    path in ROUTES
      ? Promise.resolve(ROUTES[path])
      : Promise.reject(new ApiError(404, { detail: "Not found." }))
  )
})
afterEach(() => cleanup())

function show(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const panel = (
  props: Partial<React.ComponentProps<typeof FaceplateView>> = {}
) => (
  <FaceplateView
    mode="image"
    deviceTypeId="t-sw"
    deviceId="d1"
    device={{ name: "sw-1", image_ports: null }}
    facePorts={FACE}
    interfaces={[iface()]}
    side="front"
    {...props}
  />
)

const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) throw new Error(`no ${selector} yet`)
    return el
  })

const items = () =>
  Array.from(document.querySelectorAll("[role=menuitem]")).map((el) =>
    el.textContent.trim()
  )

describe("right-click on the photo faceplate", () => {
  it("opens the port menu on an interface marker", async () => {
    perms.value = new Set([
      "cable.add",
      "cable.delete",
      "portreservation.add",
      "interface.change",
    ])
    show(panel())
    const eth1 = await found('[data-port-id="if1"]')
    fireEvent.contextMenu(eth1, { clientX: 30, clientY: 40 })
    await found(`[role="menu"][aria-label="Port"]`)
    expect(items()).toEqual([
      "Open interface",
      "Connect cable…",
      "Reserve…",
      "Mark connected",
      "Edit",
    ])
  })

  it("offers a cabled interface its trace and disconnect", async () => {
    perms.value = new Set(["cable.add", "cable.delete"])
    show(
      panel({
        interfaces: [
          iface({
            cable: {
              id: "c1",
              label: "",
              type: "",
              color: "",
              status: null,
            },
          }),
        ],
      })
    )
    fireEvent.contextMenu(await found('[data-port-id="if1"]'))
    await found(`[role="menu"][aria-label="Port"]`)
    expect(items()).toEqual(["Open interface", "Trace cable", "Disconnect…"])
  })

  it("leaves a user without write rights only Open", async () => {
    show(panel())
    fireEvent.contextMenu(await found('[data-port-id="if1"]'))
    await found(`[role="menu"][aria-label="Port"]`)
    expect(items()).toEqual(["Open interface"])
  })

  it("opens the port menu on a power port marker", async () => {
    perms.value = new Set(["cable.add", "portreservation.add"])
    show(panel())
    fireEvent.contextMenu(await found('[data-port-id="pp1"]'))
    await found(`[role="menu"][aria-label="Port"]`)
    expect(items()).toEqual(["Open on device", "Connect cable…", "Reserve…"])
  })

  it("opens the module menu on an empty bay, for a user who may install", async () => {
    perms.value = new Set(["module.add"])
    show(panel())
    fireEvent.contextMenu(await found('[data-bay-name="Slot 1"]'))
    await found(`[role="menu"][aria-label="Module bay"]`)
    expect(items()).toEqual(["Install module…"])
  })

  it("opens nothing on a bay the user may not fill", async () => {
    show(panel())
    fireEvent.contextMenu(await found('[data-bay-name="Slot 1"]'))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/module-bays/?device=d1")
    )
    // The opener decides once the bays are in.
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector("[role=menu]")).toBeNull()
  })

  it("keeps a left-click's own work: the link, and no menu", async () => {
    perms.value = new Set(["cable.add"])
    show(panel())
    const eth1 = await found('[data-port-id="if1"]')
    expect(eth1.getAttribute("href")).toBe("/interfaces/if1")
    fireEvent.click(eth1)
    expect(document.querySelector("[role=menu]")).toBeNull()
  })

  it("offers nothing where the host turns the menus off", async () => {
    perms.value = new Set(["cable.add"])
    show(panel({ menus: false }))
    fireEvent.contextMenu(await found('[data-port-id="if1"]'))
    expect(document.querySelector("[role=menu]")).toBeNull()
  })

  it("asks for nothing until the first right-click", async () => {
    perms.value = new Set(["module.add"])
    show(panel())
    await found('[data-port-id="if1"]')
    expect(apiMock).not.toHaveBeenCalledWith("/api/module-bays/?device=d1")
  })
})

// One menu, one set of dialogs: every surface opens the viewer's menus and
// none carries a copy of their dialogs.
describe("the surfaces share the viewer's menus", () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (p: string) => readFileSync(join(here, p), "utf8")
  const HOSTS = [
    "device-faceplate.tsx",
    "floorplan3d/scene.tsx",
    "floorplan3d/rack-scene.tsx",
    "cabinet-scene.tsx",
  ]
  for (const file of HOSTS)
    it(`${file} hosts useDeviceMenus and no dialog of its own`, () => {
      const src = read(file)
      expect(src).toMatch(/useDeviceMenus/)
      for (const dialog of [
        "CableDeleteDialog",
        "CableTraceDialog",
        "InterfaceTraceDialog",
        "PortReservationDialog",
        "RemoveModuleDialog",
      ])
        expect(src).not.toMatch(new RegExp(`\\b${dialog}\\b`))
    })
  it("the 3D viewer and the room pick bays with the same boxes", () => {
    for (const file of [
      "floorplan3d/model-viewer.tsx",
      "floorplan3d/device-mesh.tsx",
      "floorplan3d/floor-device-mesh.tsx",
    ])
      expect(read(file)).toMatch(/import \{ BayHits \} from "\.\/bay-hits"/)
  })
})
