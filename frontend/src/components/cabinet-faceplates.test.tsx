// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { ApiError } from "@/lib/api"
import type { Device, DeviceTypeMini, DinRail, Interface } from "@/lib/api"
import { CabinetFaceplates } from "./cabinet-faceplates"

// Render mode's faceplates, laid over the plate: the device page's Panel for
// each device - its photo with the ports marked on it, at true size where
// the photo is calibrated, else its schematic faceplate shrunk into the
// body - with the ports coloured by state and linking to themselves.

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
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children?: React.ReactNode
    to: string
    params?: Record<string, string>
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (path, [k, v]) => path.replace(`$${k}`, v),
        to
      )}
      {...rest}
    >
      {children}
    </a>
  ),
}))

/** A photo that loads at once, 100 × 245 px. */
class PhotoStub {
  onload: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  set src(_url: string) {
    queueMicrotask(() => {
      this.naturalWidth = 100
      this.naturalHeight = 245
      this.onload?.()
    })
  }
}

const R1: DinRail = {
  id: "r1",
  label: "R1",
  profile: "ts35",
  x_mm: 0,
  y_mm: 95,
  length_mm: 500,
}
/** The drawing's frame starts 31.5 mm above and left of the plate; 2 px
 * a millimetre. */
const FRAME = { x: -31.5, y: -31.5, pxPerMm: 2 }

const mini = (patch: Partial<DeviceTypeMini>): DeviceTypeMini => ({
  id: "t-photo",
  name: "XC216",
  manufacturer: null,
  manufacturer_id: null,
  u_height: 0,
  rack_width: "full",
  is_full_depth: false,
  width_mm: 140,
  height_mm: 147,
  din_profiles: ["ts35"],
  din_rail_mm: null,
  front_image: "/media/xc216.png",
  rear_image: null,
  ...patch,
})

const device = (
  id: string,
  name: string,
  type: DeviceTypeMini,
  offset: number
) =>
  ({
    id,
    name,
    device_type: type,
    role: null,
    vc_position: null,
    port_labels: "",
    image_ports: null,
    cabinet: { id: "c1", name: "K1" },
    din_rail: { id: "r1", label: "R1", profile: "ts35" },
    din_offset_mm: offset,
  }) as unknown as Device

const marker = (name: string, y: number) => ({
  kind: "interface",
  name,
  x: 0.7,
  y,
  w: 0.12,
  h: 0.06,
})

const iface = (id: string, name: string, cabled: boolean) =>
  ({
    id,
    name,
    device: { id: "d", name: "d" },
    virtual: false,
    enabled: true,
    cable: cabled
      ? { id: `c-${id}`, label: "", type: "cat6", color: "", status: null }
      : null,
    speed: cabled ? "1G" : "",
    type: "1000base-t",
    type_display: "1000BASE-T (1GE)",
    mode: "",
    vlan: null,
    tagged_vlans: [],
    ip_addresses: [],
    tags: [],
  }) as unknown as Interface

const page = (results: unknown[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const PHOTO = mini({})
const CAL = mini({
  id: "t-cal",
  name: "XC206",
  width_mm: 60,
  front_image: "/media/xc206.png",
  front_cal: { left: 0.1, right: 0.9, span_mm: 48, rail: 0.55, photo_mm: 60 },
})
const SCHEMATIC = mini({ id: "t-sch", name: "PLC", front_image: null })
const BARE = mini({ id: "t-bare", name: "Relay", front_image: null })

const ROUTES: Record<string, unknown> = {
  "/api/device-types/t-photo/": {
    ...PHOTO,
    faceplate: null,
    image_ports: {
      front: [marker("P1", 0.2), marker("P2", 0.3), marker("P9", 0.4)],
      rear: [],
    },
  },
  "/api/device-types/t-cal/": {
    ...CAL,
    faceplate: null,
    image_ports: { front: [marker("P1", 0.2)], rear: [] },
  },
  "/api/device-types/t-sch/": { ...SCHEMATIC, faceplate: null },
  "/api/device-types/t-bare/": { ...BARE, faceplate: null },
  "/api/devices/d1/interfaces/": page([
    iface("i1", "P1", true),
    iface("i2", "P2", false),
  ]),
  "/api/devices/d1/": { id: "d1", name: "sw-1", image_ports: null },
  "/api/monitoring/devices/d1/snmp/": {
    interfaces: [
      { name: "P1", oper_status: "up", admin_status: "up", speed_mbps: "1000" },
    ],
  },
  "/api/devices/d2/interfaces/": page([iface("i21", "P1", true)]),
  "/api/devices/d2/": { id: "d2", name: "sw-2", image_ports: null },
  "/api/devices/d3/interfaces/": page([
    iface("e1", "eth1", true),
    iface("e2", "eth2", false),
  ]),
  "/api/modules/?device=d3": page([]),
  "/api/devices/d4/interfaces/": page([]),
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    path in ROUTES
      ? Promise.resolve(ROUTES[path])
      : Promise.reject(new ApiError(404, { detail: "Not found." }))
  )
  vi.stubGlobal("Image", PhotoStub)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function draw(
  devices: Device[],
  {
    labels = true,
    onLive,
  }: { labels?: boolean; onLive?: (id: string, live: boolean) => void } = {}
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <div className="relative">
        <CabinetFaceplates
          rails={[R1]}
          devices={devices}
          frame={FRAME}
          labels={labels}
          onLive={onLive}
        />
      </div>
    </QueryClientProvider>
  )
}

const face = (name: string) =>
  document.querySelector<HTMLElement>(`[data-face="${name}"]`)
const box = (el: HTMLElement | null | undefined) =>
  ["left", "top", "width", "height"].map((k) =>
    Number.parseFloat(el?.style.getPropertyValue(k) ?? "")
  )

describe("CabinetFaceplates", () => {
  it("lays a photo-port device's photo, ports marked, over its body", async () => {
    const onLive = vi.fn()
    draw([device("d1", "sw-1", PHOTO, 0)], { onLive })
    await waitFor(() => expect(face("sw-1")).not.toBeNull())
    const f = face("sw-1")!
    expect(f.dataset.look).toBe("photo")
    // The body: 0 along R1, hung on its middle - 95 less half of 147.
    expect(box(f)).toEqual([63, 106, 280, 294])
    // The photo stretched over the whole of it, as Images draws it.
    expect(box(f.firstElementChild as HTMLElement)).toEqual([0, 0, 280, 294])
    await waitFor(() =>
      expect(f.querySelector("img")?.getAttribute("src")).toBe(
        "/media/xc216.png"
      )
    )
    expect(f.querySelector("img")?.className).toContain("h-full w-full")
    // Each port links to itself, coloured as on the device page.
    const p1 = await waitFor(() => {
      const el = f.querySelector<HTMLAnchorElement>('a[data-port-name="P1"]')
      if (!el) throw new Error("no P1 yet")
      return el
    })
    expect(p1.getAttribute("href")).toBe("/interfaces/i1")
    expect(p1.style.borderColor).toBe("rgb(16, 185, 129)") // the 1G tier
    const p2 = f.querySelector<HTMLAnchorElement>('a[data-port-name="P2"]')
    expect(p2?.getAttribute("href")).toBe("/interfaces/i2")
    expect(p2?.style.backgroundColor).toBe("transparent") // free: no fill
    // A marker with no port of that name on the device is a ghost.
    expect(f.querySelector('[title="P9 (not on this device)"]')).not.toBeNull()
    // SNMP's word on P1: a live dot, and the section told.
    await waitFor(() =>
      expect(p1.querySelector(".bg-emerald-500")).not.toBeNull()
    )
    expect(onLive).toHaveBeenCalledWith("d1", true)
    expect(f.querySelector('[data-part="name"]')?.textContent).toBe("sw-1")
  })

  it("draws a calibrated photo at its true size, its markers with it", async () => {
    draw([device("d2", "sw-2", CAL, 140)])
    const f = await waitFor(() => {
      const el = face("sw-2")
      if (!el) throw new Error("not drawn yet")
      return el
    })
    expect(box(f)).toEqual([343, 106, 120, 294])
    // 60 mm wide, 147 tall from its 100 × 245 px; its left guide (0.1 in) on
    // the body's left edge, its rail line (0.55 down) on R1.
    const photo = box(f.firstElementChild as HTMLElement)
    expect(photo.map((v) => Math.round(v * 100) / 100)).toEqual([
      -12, -14.7, 120, 294,
    ])
    // The body clips it.
    expect(f.className).toContain("overflow-hidden")
    await waitFor(() =>
      expect(f.querySelector('a[data-port-name="P1"]')).not.toBeNull()
    )
  })

  it("shrinks a type's schematic faceplate into the body", async () => {
    draw([device("d3", "plc-1", SCHEMATIC, 0)])
    const f = await waitFor(() => {
      const el = face("plc-1")
      if (!el) throw new Error("not drawn yet")
      return el
    })
    expect(f.dataset.look).toBe("schematic")
    expect(f.querySelector('[data-part="fit"]')).not.toBeNull()
    const port = await waitFor(() => {
      const el = f.querySelector('a[href="/interfaces/e1"]')
      if (!el) throw new Error("no cage yet")
      return el
    })
    expect(port.getAttribute("data-port-name")).toBe("eth1")
    expect(f.querySelector('a[href="/interfaces/e2"]')).not.toBeNull()
  })

  it("leaves a device with no ports to the body under it", async () => {
    draw([
      device("d4", "relay-1", BARE, 300),
      device("d3", "plc-1", SCHEMATIC, 0),
    ])
    await waitFor(() => expect(face("plc-1")).not.toBeNull())
    expect(face("relay-1")).toBeNull()
  })

  it("lets presses through to the bodies, but not off the ports", async () => {
    draw([device("d1", "sw-1", PHOTO, 0)])
    await waitFor(() => expect(face("sw-1")).not.toBeNull())
    expect(
      document.querySelector('[data-part="faceplates"]')?.className
    ).toContain("pointer-events-none")
    expect(face("sw-1")?.className).toContain("[&_a]:pointer-events-auto")
  })

  it("writes no names with the labels off", async () => {
    draw([device("d1", "sw-1", PHOTO, 0)], { labels: false })
    await waitFor(() => expect(face("sw-1")).not.toBeNull())
    expect(screen.queryByText("sw-1")).toBeNull()
  })
})
