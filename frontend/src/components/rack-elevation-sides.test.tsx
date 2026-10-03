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
import type { RackDisplayMode, RackFace, RackShow } from "./rack-elevation"

// A full-depth device fills both faces of the rack: on the face it is
// mounted on it shows its front, on the other its other side - its rear
// photo with the ports marked on it, or the drawing of its rear - and
// hatching with its name where its type has no plate for that side. The
// Show filter keeps one face's gear: the rest stays as nameless hatched
// space. A device's ports in use show once, on the face it is mounted on.

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
    createLink:
      (Comp: React.ComponentType<Record<string, unknown>>) =>
      ({ to, params, search: _search, ...rest }: LinkProps) => (
        <Comp href={href(to, params)} {...rest} />
      ),
  }
})

const RACK = {
  id: "r2",
  name: "R2",
  u_height: 6,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  role: null,
  used_units: 3,
} as unknown as Rack

const typeMini = (
  id: string,
  images: { front?: string; rear?: string } = {}
) => ({
  id,
  name: id,
  u_height: 1,
  rack_width: "full",
  is_full_depth: true,
  front_image: images.front ?? null,
  rear_image: images.rear ?? null,
})

const device = (
  id: string,
  name: string,
  type: ReturnType<typeof typeMini>,
  position: number,
  face: RackFace
) =>
  ({
    id,
    name,
    device_type: type,
    position,
    face,
    mount: "",
    u_height: 1,
    rack_width: "full",
    rack_side: "",
    vc_position: null,
    port_labels: "",
    image_ports: null,
    role: null,
  }) as unknown as Device

// A server with front and rear photos, its NIC and PSU marked on the rear;
// a box with no photo or drawing of its rear; a fan mounted on the rear.
const SRV_T = typeMini("t-srv", {
  front: "/media/srv-front.png",
  rear: "/media/srv-rear.png",
})
const BOX_T = typeMini("t-box")
const FAN_T = typeMini("t-fan")
const SRV = device("d1", "srv-1", SRV_T, 5, "front")
const BOX = device("d2", "box-1", BOX_T, 3, "front")
const FAN = device("d3", "fan-1", FAN_T, 1, "rear")

const marker = (kind: string, name: string, x: number) => ({
  kind,
  name,
  x,
  y: 0.5,
  w: 0.05,
  h: 0.4,
})

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

const counts = (total: number, connected: number) => ({
  total,
  connected,
  reserved: 0,
  free: total - connected,
  marked: 0,
})

const state = (observed = false, countVirtual = false): RackPortState => ({
  rack: {
    id: "r2",
    u_height: 6,
    u_used: 3,
    u_free: 3,
    power: { available_w: 0, allocated_w: 0, maximum_w: 0 },
    ports: counts(6, 1),
    count_virtual: countVirtual,
  },
  devices: {
    d1: {
      ports: counts(2, 1),
      face: {
        front: [],
        rear: [
          facePort({
            marker: "eno1",
            name: "eno1",
            id: "j1",
            connected: true,
            cable_state: "connected",
            cable_id: "c1",
          }),
          facePort({
            marker: "PSU1",
            name: "PSU1",
            kind: "power_port",
            id: "pp1",
            connected: true,
            cable_state: "connected",
            cable_id: "c2",
          }),
        ],
      },
      interfaces: [
        row({
          id: "j1",
          name: "eno1",
          cable_state: "connected",
          cable_id: "c1",
        }),
        row({ id: "j2", name: "eno2" }),
      ],
      modules: [],
      components: {},
      observed,
    },
    d2: {
      ports: counts(4, 0),
      face: { front: [], rear: [] },
      interfaces: [row({ id: "k1", name: "eth0" })],
      modules: [],
      components: {},
      observed,
    },
    d3: {
      ports: counts(0, 0),
      face: { front: [], rear: [] },
      interfaces: [],
      modules: [],
      components: {},
      observed,
    },
  },
})

const page = (results: unknown[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const ROUTES: Record<string, unknown> = {
  "/api/devices/?rack=r2": page([SRV, BOX, FAN]),
  "/api/planning/planned-changes/?state=planned&page_size=300": page([]),
  "/api/device-types/t-srv/": {
    ...SRV_T,
    faceplate: null,
    image_ports: {
      front: [marker("inventory-item", "Disk 0", 0.2)],
      rear: [
        marker("interface", "eno1", 0.3),
        marker("power-port", "PSU1", 0.8),
      ],
    },
  },
  "/api/device-types/t-box/": { ...BOX_T, faceplate: null, image_ports: null },
  "/api/device-types/t-fan/": { ...FAN_T, faceplate: null, image_ports: null },
  "/api/monitoring/devices/d1/snmp/": { interfaces: [] },
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    path in ROUTES
      ? Promise.resolve(ROUTES[path])
      : Promise.reject(new ApiError(404, { detail: "Not found." }))
  )
})
afterEach(() => cleanup())

function draw(
  face: RackFace,
  mode: RackDisplayMode,
  {
    ports = state(),
    show = "all",
  }: { ports?: RackPortState | null; show?: RackShow } = {}
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RackElevation
        rack={RACK}
        face={face}
        mode={mode}
        labels
        showHeader={false}
        ports={ports ?? undefined}
        show={show}
      />
    </QueryClientProvider>
  )
}

/** A device's block: the link to it, or the hatched space the Show filter
 * leaves. */
const block = (name: string) =>
  document.querySelector<HTMLElement>(`[data-device="${name}"]`) ??
  [...document.querySelectorAll<HTMLElement>("[data-view]")].find((el) =>
    el.textContent.includes(name)
  ) ??
  null
const striped = (el: HTMLElement | null) =>
  !!el?.style.backgroundImage.includes("repeating-linear-gradient")
const badges = () =>
  [...document.querySelectorAll<HTMLElement>('[data-part="ports"]')].map(
    (b) => b.textContent
  )
const requested = () => apiMock.mock.calls.map(([path]) => path)
async function found(selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) throw new Error(`no ${selector} yet`)
    return el
  })
}

describe("a full-depth device's other side", () => {
  it("draws its rear plate, live, on the face it isn't mounted on", async () => {
    draw("rear", "render")
    // The server's rear photo with its NIC and PSU marked on it.
    const face = await found('[data-live-face="srv-1"]')
    expect(face.dataset.side).toBe("rear")
    await waitFor(() => expect(face.dataset.look).toBe("photo"))
    const nic = await found('[data-live-face="srv-1"] a[data-port-name="eno1"]')
    expect(nic.getAttribute("href")).toBe("/interfaces/j1")
    expect(nic.dataset.cableState).toBe("connected")
    expect(
      document.querySelector(
        '[data-live-face="srv-1"] button[data-port-name="PSU1"]'
      )
    ).not.toBeNull()
    // The box has no plate for its rear: hatched, its name kept.
    const box = await found('a[href="/devices/d2"]')
    expect(box.dataset.view).toBe("other")
    expect(box.textContent).toContain("box-1")
    expect(striped(box)).toBe(true)
    expect(document.querySelector('[data-live-face="box-1"]')).toBeNull()
    // Each device's ports in use show on the face it is mounted on only.
    expect(badges()).toEqual([])
    // Nothing SNMP may have seen: no live state asked for.
    expect(requested().filter((p) => p.includes("/snmp/"))).toEqual([])
  })

  it("is a plain block in Names, its ports counted on its own face only", async () => {
    draw("rear", "names")
    await waitFor(() => expect(block("srv-1")).not.toBeNull())
    const srv = document.querySelector<HTMLElement>('a[href="/devices/d1"]')!
    expect(srv.dataset.view).toBe("other")
    expect(striped(srv)).toBe(false)
    expect(srv.textContent).toContain("srv-1")
    expect(badges()).toEqual([])
    cleanup()
    draw("front", "names")
    await waitFor(() =>
      expect(badges()).toEqual(
        ["1 / 2", "0 / 4"].map((t) => `${t} ports in use`)
      )
    )
  })

  it("keeps the bare rear photo and the hatching with the Ports off", async () => {
    draw("rear", "images", { ports: null })
    const img = await found('a[href="/devices/d1"] img')
    expect(img.getAttribute("src")).toBe("/media/srv-rear.png")
    const box = document.querySelector<HTMLElement>('a[href="/devices/d2"]')!
    expect(striped(box)).toBe(true)
    expect(box.textContent).toContain("box-1")
    expect(document.querySelector("[data-live-face]")).toBeNull()
    expect(badges()).toEqual([])
  })

  it("asks for live state only where SNMP may have seen the ports", async () => {
    draw("rear", "render", { ports: state(true) })
    await found('[data-live-face="srv-1"] a[data-port-name="eno1"]')
    await waitFor(() =>
      expect(requested()).toContain("/api/monitoring/devices/d1/snmp/")
    )
    // The box's other side draws no ports, so it asks for none.
    expect(requested().filter((p) => p.includes("/snmp/"))).toEqual([
      "/api/monitoring/devices/d1/snmp/",
    ])
  })
})

describe("the Show filter", () => {
  it("keeps one face's gear; the rest is nameless hatched space", async () => {
    draw("front", "render", { show: "rear" })
    // The front-mounted server and box: hatched, no name, nothing to open.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-view="hidden"]')).toHaveLength(2)
    )
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-view="hidden"]'
    )) {
      expect(el.tagName).toBe("DIV")
      expect(el.textContent).toBe("")
      expect(striped(el)).toBe(true)
    }
    expect(document.querySelector("[data-live-face]")).toBeNull()
    expect(badges()).toEqual([])
    // The rear-mounted fan's other side, with no plate: hatched, named.
    const fan = document.querySelector<HTMLElement>('a[href="/devices/d3"]')!
    expect(fan.dataset.view).toBe("other")
    expect(striped(fan)).toBe(true)
    expect(fan.textContent).toContain("fan-1")
  })

  it("leaves the other face's gear out on its own face too", async () => {
    draw("rear", "images", { show: "front" })
    // The fan, mounted here, is left out; the server's rear plate shows.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-view="hidden"]')).toHaveLength(1)
    )
    expect(document.querySelector('a[href="/devices/d3"]')).toBeNull()
    await found('[data-live-face="srv-1"][data-side="rear"]')
  })
})

describe("the ports badge", () => {
  it("says what it counts on hover", async () => {
    draw("front", "names")
    const badge = await found('a[href="/devices/d1"] [data-part="ports"]')
    fireEvent.focus(badge)
    // Radix writes a tooltip's text twice: on screen, and for the reader.
    expect(await screen.findAllByText("1 of 2 ports in use")).not.toHaveLength(
      0
    )
    expect(
      screen.getAllByText(
        "Cabled or reserved, of its physical interfaces and front ports"
      )
    ).not.toHaveLength(0)
  })

  it("names virtual interfaces where the deployment counts them", async () => {
    draw("front", "names", { ports: state(false, true) })
    const badge = await found('a[href="/devices/d1"] [data-part="ports"]')
    fireEvent.focus(badge)
    expect(
      await screen.findAllByText(
        "Cabled or reserved, of its physical interfaces, front ports and virtual interfaces"
      )
    ).not.toHaveLength(0)
  })
})
