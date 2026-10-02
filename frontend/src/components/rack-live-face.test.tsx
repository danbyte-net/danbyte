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
import { ApiError } from "@/lib/api"
import type {
  Device,
  FacePort,
  Rack,
  RackPortInterface,
  RackPortState,
} from "@/lib/api"
import { RackElevation } from "./rack-elevation"
import type { RackDisplayMode } from "./rack-elevation"

// The rack page's live elevation (#248): every device's ports drawn as its
// device page draws them, fed from the rack's one port-state request - so
// the page makes no request per device for them - with the ports in use on
// every block and a press on a cabled port opening its trace.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: () => false,
    faceplateMarkedLit: false,
    faceplatePortLabels: "",
    faceplatePortLabelColor: "#ffffff",
    faceplateGroupLabels: false,
  }),
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
    Link: ({ children, to, params, search: _search, ...rest }: LinkProps) => (
      <a href={href(to, params)} {...rest}>
        {children}
      </a>
    ),
    // The trace dialog's Open link.
    createLink:
      (Comp: React.ComponentType<Record<string, unknown>>) =>
      ({ to, params, search: _search, ...rest }: LinkProps) => (
        <Comp href={href(to, params)} {...rest} />
      ),
  }
})

const RACK = {
  id: "r1",
  name: "R1",
  u_height: 4,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  role: null,
  used_units: 3,
} as unknown as Rack

const typeMini = (id: string, front_image: string | null) => ({
  id,
  name: id,
  u_height: 1,
  rack_width: "full",
  is_full_depth: false,
  front_image,
  rear_image: null,
})

const device = (
  id: string,
  name: string,
  type: ReturnType<typeof typeMini>,
  position: number
) =>
  ({
    id,
    name,
    device_type: type,
    position,
    face: "front",
    mount: "",
    u_height: 1,
    rack_width: "full",
    rack_side: "",
    vc_position: null,
    port_labels: "",
    image_ports: null,
    role: null,
  }) as unknown as Device

const DRAWN = typeMini("t-drawn", null)
const PHOTO = typeMini("t-photo", "/media/fw.png")
const SW = device("d1", "sw-1", DRAWN, 4)
const FW = device("d2", "fw-1", PHOTO, 3)
const PANEL = device("d3", "panel-1", DRAWN, 2)

const row = (patch: Partial<RackPortInterface>): RackPortInterface => ({
  id: "i",
  name: "",
  label: "",
  type: "1000base-t",
  type_display: "1000BASE-T (1GE)",
  speed: "1G",
  enabled: true,
  mode: "",
  mark_connected: false,
  cable_state: "free",
  cable_id: null,
  cable_label: "",
  cable_type: "",
  peer: null,
  hide_label: false,
  label_color: "",
  vlan: null,
  tagged_vlan_count: 0,
  lag: null,
  ip_addresses: [],
  description: "",
  mac_address: "",
  mtu: null,
  tags: [],
  ...patch,
})

const facePort = (patch: Partial<FacePort>): FacePort => ({
  marker: "",
  name: "",
  kind: "interface",
  id: null,
  connected: false,
  cable_id: null,
  enabled: true,
  speed: "",
  type: "",
  status: null,
  module: null,
  drift: null,
  ...patch,
})

const marker = (kind: string, name: string, x: number) => ({
  kind,
  name,
  x,
  y: 0.5,
  w: 0.05,
  h: 0.4,
})

const counts = (total: number, connected: number, reserved: number) => ({
  total,
  connected,
  reserved,
  free: total - connected - reserved,
  marked: 0,
})

const STATE: RackPortState = {
  rack: {
    id: "r1",
    u_height: 4,
    u_used: 3,
    u_free: 1,
    power: { available_w: 0, allocated_w: 0, maximum_w: 0 },
    ports: counts(5, 3, 1),
    count_virtual: false,
  },
  devices: {
    d1: {
      ports: counts(3, 1, 1),
      face: { front: [], rear: [] },
      interfaces: [
        row({
          id: "i1",
          name: "Gi1/0/1",
          cable_state: "connected",
          cable_id: "c1",
          cable_type: "cat6",
          peer: { device: "core-1", port: "Te1/1", port_label: "" },
        }),
        row({ id: "i2", name: "Gi1/0/2", cable_state: "reserved" }),
        row({
          id: "i3",
          name: "Te1/2/1",
          type: "10gbase-x-sfpp",
          type_display: "SFP+ (10GE)",
          speed: "",
        }),
      ],
      // A line card in bay 2: its port composes into the drawing.
      modules: [
        {
          id: "m1",
          module_bay: { id: "b1", name: "Slot 2", position: "2" },
          module_type_faceplate: null,
          module_interfaces: [{ name: "Te1/2/1", type: "10gbase-x-sfpp" }],
        },
      ],
      // The console port the type's layout places.
      components: {
        "console-port": [{ id: "cp1", name: "CON", type: "rj-45" }],
      },
    },
    d2: {
      ports: counts(2, 2, 0),
      face: {
        front: [
          facePort({
            marker: "eth1",
            name: "eth1",
            id: "j1",
            connected: true,
            cable_state: "connected",
            cable_id: "c9",
          }),
          facePort({ marker: "eth2", name: "eth2", id: "j2" }),
          facePort({
            marker: "con",
            name: "con",
            kind: "console_port",
            id: "cp9",
            connected: true,
            cable_state: "connected",
            cable_id: "c7",
            peer: { device: "oob-1", port: "port 3", port_label: "" },
          }),
          facePort({
            marker: "Disk 0",
            name: "Disk 0",
            kind: null,
            id: "inv1",
            status: {
              id: "s1",
              name: "Failed",
              color: "#ef4444",
              text_color: "#ffffff",
            },
          }),
        ],
        rear: [],
      },
      interfaces: [
        row({
          id: "j1",
          name: "eth1",
          cable_state: "connected",
          cable_id: "c9",
        }),
        row({ id: "j2", name: "eth2", cable_state: "connected" }),
      ],
      modules: [],
      components: {},
    },
    // A device with no counted port gets no badge.
    d3: {
      ports: counts(0, 0, 0),
      face: { front: [], rear: [] },
      interfaces: [],
      modules: [],
      components: {},
    },
  },
}

const page = (results: unknown[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const ROUTES: Record<string, unknown> = {
  "/api/devices/?rack=r1": page([SW, FW, PANEL]),
  "/api/planning/planned-changes/?state=planned&page_size=300": page([]),
  "/api/component-popover/": {
    fields: ["name", "type", "state", "peer", "vlan", "live", "ips"],
  },
  "/api/device-types/t-drawn/": {
    ...DRAWN,
    image_ports: null,
    faceplate: {
      v: 1,
      front: [
        {
          id: "g1",
          rows: 1,
          bank: 0,
          slots: [
            { t: "port", name: "Gi1/0/1" },
            { t: "port", name: "Gi1/0/2" },
            { t: "port", kind: "console-port", name: "CON" },
          ],
        },
      ],
      rear: [],
    },
  },
  "/api/device-types/t-photo/": {
    ...PHOTO,
    faceplate: null,
    image_ports: {
      front: [
        marker("interface", "eth1", 0.2),
        marker("interface", "eth2", 0.3),
        marker("console-port", "con", 0.5),
        marker("inventory-item", "Disk 0", 0.8),
      ],
      rear: [],
    },
  },
  "/api/monitoring/devices/d1/snmp/": {
    interfaces: [
      {
        name: "Gi1/0/1",
        oper_status: "up",
        admin_status: "up",
        speed_mbps: "1000",
      },
    ],
  },
  "/api/monitoring/devices/d2/snmp/": { interfaces: [] },
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    // A trace stays loading: the dialog's title is what is checked.
    if (path.includes("/trace/")) return new Promise(() => {})
    return path in ROUTES
      ? Promise.resolve(ROUTES[path])
      : Promise.reject(new ApiError(404, { detail: "Not found." }))
  })
})
afterEach(() => cleanup())

function draw(mode: RackDisplayMode, ports: RackPortState | null = STATE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RackElevation
        rack={RACK}
        face="front"
        mode={mode}
        labels
        showHeader={false}
        ports={ports ?? undefined}
      />
    </QueryClientProvider>
  )
}

const face = (name: string) =>
  document.querySelector<HTMLElement>(`[data-live-face="${name}"]`)
async function port(selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) throw new Error(`no ${selector} yet`)
    return el
  })
}
const requested = () => apiMock.mock.calls.map(([path]) => path)

describe("RackElevation with the rack's port state", () => {
  it("draws every device's ports without a request per device", async () => {
    draw("render")
    // No photo: the type's drawn faceplate, its ports live.
    const gi1 = await port(
      '[data-live-face="sw-1"] a[data-port-name="Gi1/0/1"]'
    )
    expect(face("sw-1")?.dataset.look).toBe("drawn")
    expect(gi1.getAttribute("href")).toBe("/interfaces/i1")
    expect(gi1.dataset.cableState).toBe("connected")
    expect(
      document
        .querySelector('[data-live-face="sw-1"] [data-port-name="Gi1/0/2"]')
        ?.getAttribute("data-cable-state")
    ).toBe("reserved")
    // The module's port and the placed console port, from the payload.
    await port('[data-live-face="sw-1"] a[data-port-name="Te1/2/1"]')
    expect(
      document.querySelector('[data-live-face="sw-1"] [title="CON · rj-45"]')
    ).not.toBeNull()
    // SNMP's word on Gi1/0/1: its live dot.
    await waitFor(() =>
      expect(gi1.querySelector(".bg-emerald-500")).not.toBeNull()
    )

    // A photo with ports marked: the photo, its markers coloured.
    const eth1 = await port('[data-live-face="fw-1"] a[data-port-name="eth1"]')
    expect(face("fw-1")?.dataset.look).toBe("photo")
    expect(eth1.getAttribute("href")).toBe("/interfaces/j1")
    // A hardware marker wears its part's status, from the payload.
    const disk = await port(
      '[data-live-face="fw-1"] [style*="border-color: rgb(239, 68, 68)"]'
    )
    expect(disk.tagName).toBe("SPAN")

    // Ports in use over counted ports; nothing where none are counted.
    const badges = [
      ...document.querySelectorAll<HTMLElement>('[data-part="ports"]'),
    ].map((b) => b.textContent)
    expect(badges).toEqual(["2 / 3 ports in use", "2 / 2 ports in use"])

    // One request per type and per device that draws interface ports - no
    // modules, component lists, face ports, parts or device records.
    const paths = requested()
    expect(
      paths.filter((p) =>
        /\/api\/modules\/|face-ports|-ports\/\?|inventory-items|snmp\/drift|\/api\/devices\/d\d\/$/.test(
          p
        )
      )
    ).toEqual([])
    expect(
      paths.filter((p) => p.startsWith("/api/device-types/")).sort()
    ).toEqual(["/api/device-types/t-drawn/", "/api/device-types/t-photo/"])
    expect(paths.filter((p) => p.includes("/snmp/")).sort()).toEqual([
      "/api/monitoring/devices/d1/snmp/",
      "/api/monitoring/devices/d2/snmp/",
    ])
  })

  it("opens a cabled port's trace where it stands; a free port keeps its link", async () => {
    draw("render")
    const gi1 = await port(
      '[data-live-face="sw-1"] a[data-port-name="Gi1/0/1"]'
    )
    fireEvent.click(gi1)
    expect(await screen.findByText("sw-1:Gi1/0/1")).not.toBeNull()
    expect(apiMock).toHaveBeenCalledWith(
      "/api/interfaces/i1/trace/?include=card,link_ips"
    )
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await waitFor(() => expect(screen.queryByText("sw-1:Gi1/0/1")).toBeNull())

    // Any other cabled kind traces by its cable.
    const con = await port(
      '[data-live-face="fw-1"] button[data-port-name="con"]'
    )
    fireEvent.click(con)
    expect(await screen.findByText("fw-1:con")).not.toBeNull()
    expect(apiMock).toHaveBeenCalledWith(
      "/api/cables/c7/trace/?include=card,link_ips"
    )

    // A free port is still a link to itself.
    const te = await port('[data-live-face="sw-1"] a[data-port-name="Te1/2/1"]')
    expect(te.getAttribute("href")).toBe("/interfaces/i3")
  })

  it("names the far end in the port's hover card", async () => {
    draw("render")
    const gi1 = await port(
      '[data-live-face="sw-1"] a[data-port-name="Gi1/0/1"]'
    )
    fireEvent.focus(gi1)
    const far = await screen.findByText(/core-1/)
    expect(far.textContent).toBe("→ core-1:Te1/1")
    // A console port's marker names its far end too.
    const con = await port(
      '[data-live-face="fw-1"] button[data-port-name="con"]'
    )
    fireEvent.focus(con)
    expect((await screen.findByText(/oob-1/)).textContent).toBe(
      "→ oob-1:port 3"
    )
  })

  it("shows the ports in use on Names blocks, with no live faces", async () => {
    draw("names")
    await waitFor(() =>
      expect(document.querySelectorAll('[data-part="ports"]')).toHaveLength(2)
    )
    expect(document.querySelector("[data-live-face]")).toBeNull()
    expect(requested().filter((p) => p.includes("/snmp/"))).toEqual([])
  })

  it("marks the photo's ports in Images; a device without a photo keeps its block", async () => {
    draw("images")
    const eth1 = await port('[data-live-face="fw-1"] a[data-port-name="eth1"]')
    expect(eth1.dataset.cableState).toBe("connected")
    expect(face("sw-1")).toBeNull()
    // sw-1's own block still names it and counts its ports.
    const block = document.querySelector<HTMLElement>('a[href="/devices/d1"]')
    expect(block?.textContent).toContain("sw-1")
    expect(block?.querySelector('[data-part="ports"]')?.textContent).toBe(
      "2 / 3 ports in use"
    )
    // No drawn faceplate here, so no live state for sw-1.
    expect(requested().filter((p) => p.includes("/snmp/"))).toEqual([
      "/api/monitoring/devices/d2/snmp/",
    ])
  })

  it("leaves the elevation as it was without port state", async () => {
    draw("render", null)
    await waitFor(() => expect(requested()).toContain("/api/devices/?rack=r1"))
    await waitFor(() =>
      expect(
        document.querySelector('[data-device="sw-1"], a[href="/devices/d1"]')
      ).not.toBeNull()
    )
    expect(document.querySelector("[data-live-face]")).toBeNull()
    expect(document.querySelector('[data-part="ports"]')).toBeNull()
    expect(requested().filter((p) => p.includes("/snmp/"))).toEqual([])
  })
})
