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
  FacePort,
  FacePorts,
  InventoryItemRow,
  Paginated,
  RackPortState,
  StatusMini,
} from "@/lib/api"
import { ImagePortsFaceplate } from "./device-faceplate"
import { PortHud } from "./floorplan3d/hud-cards"
import { PartMarkerMenu, PartStatusPicker } from "./part-status"

// A hardware part's status - active, failed, spare - set from wherever its
// photo marker shows: the part's card carries the catalog's statuses as
// pills, a right-click on the marker the same choices as a menu. The write
// shows at once in every view that draws the part, and goes back if the
// server refuses it.

const { apiMock, allowed } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  allowed: { value: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (type: string, action: string) =>
      allowed.value && type === "inventoryitem" && action === "change",
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

const status = (id: string, name: string, color: string) => ({
  id,
  name,
  color,
  text_color: "#ffffff",
})
const ACTIVE: StatusMini = status("s-act", "Active", "#10b981")
const FAILED = status("s-fail", "Failed", "#ef4444")
const SPARE = status("s-spare", "Spare", "#a1a1aa")

const page = <T,>(results: T[]): Paginated<T> => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})

const disk = (s: StatusMini | null): FacePort => ({
  marker: "disk4",
  name: "disk4",
  kind: null,
  id: "p1",
  connected: false,
  cable_id: null,
  enabled: true,
  speed: "",
  type: "",
  status: s,
  module: null,
  drift: null,
})
const face = (s: StatusMini | null): FacePorts => ({
  front: [disk(s)],
  rear: [],
})

const ROUTES: Record<string, unknown> = {
  "/api/statuses/?available_to=inventoryitem&picker=1": page([
    ACTIVE,
    FAILED,
    SPARE,
  ]),
  "/api/device-types/t-srv/": {
    id: "t-srv",
    name: "x3650",
    u_height: 2,
    rack_width: "full",
    front_image: "/media/srv-front.png",
    rear_image: null,
    faceplate: null,
    image_ports: {
      front: [
        {
          kind: "inventory-item",
          name: "disk4",
          x: 0.3,
          y: 0.5,
          w: 0.05,
          h: 0.4,
        },
      ],
      rear: [],
    },
  },
  "/api/devices/d1/face-ports/": face(ACTIVE),
}

let patch: { resolve: (v: unknown) => void; reject: (e: unknown) => void }

beforeEach(() => {
  allowed.value = true
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "PATCH")
      return new Promise((resolve, reject) => {
        patch = { resolve, reject }
      })
    return path in ROUTES
      ? Promise.resolve(ROUTES[path])
      : Promise.reject(new ApiError(404, { detail: "Not found." }))
  })
})
afterEach(() => cleanup())

/** A client holding the part in every cache that draws it. */
function seeded(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData<Paginated<InventoryItemRow>>(
    ["device-inventory", "d1"],
    page([{ id: "p1", name: "disk4", status: ACTIVE } as InventoryItemRow])
  )
  qc.setQueryData(["device-face-ports", "d1"], face(ACTIVE))
  qc.setQueryData<RackPortState>(["rack-port-state", "r1"], {
    rack: {} as RackPortState["rack"],
    devices: {
      d1: {
        face: face(ACTIVE),
      } as RackPortState["devices"][string],
    },
  })
  qc.setQueryData(["cabinet-face-ports", "d1"], { d1: face(ACTIVE) })
  return qc
}

/** The part's status in each cache. */
function everywhere(qc: QueryClient) {
  return [
    qc.getQueryData<Paginated<InventoryItemRow>>(["device-inventory", "d1"])!
      .results[0].status?.name,
    qc.getQueryData<FacePorts>(["device-face-ports", "d1"])!.front[0].status
      ?.name,
    qc.getQueryData<RackPortState>(["rack-port-state", "r1"])!.devices.d1.face
      .front[0].status?.name,
    qc.getQueryData<Record<string, FacePorts>>(["cabinet-face-ports", "d1"])!.d1
      .front[0].status?.name,
  ]
}

const show = (qc: QueryClient, ui: React.ReactElement) =>
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)

const PART = { id: "p1", name: "disk4", deviceId: "d1", status: ACTIVE }

describe("PartStatusPicker", () => {
  it("marks the current status and sets another at once, everywhere", async () => {
    const qc = seeded()
    show(qc, <PartStatusPicker part={PART} />)
    const failed = await screen.findByRole("radio", { name: /Failed/ })
    expect(
      screen.getByRole("radio", { name: /Active/ }).getAttribute("aria-checked")
    ).toBe("true")
    fireEvent.click(failed)
    await waitFor(() =>
      expect(everywhere(qc)).toEqual(["Failed", "Failed", "Failed", "Failed"])
    )
    expect(apiMock).toHaveBeenCalledWith("/api/inventory-items/p1/", {
      method: "PATCH",
      body: JSON.stringify({ status_id: "s-fail" }),
    })
    patch.resolve({ id: "p1", status: FAILED })
    // Then read again from the server.
    await waitFor(() =>
      expect(qc.getQueryState(["rack-port-state", "r1"])?.isInvalidated).toBe(
        true
      )
    )
    expect(qc.getQueryState(["device-face-ports", "d1"])?.isInvalidated).toBe(
      true
    )
  })

  it("puts the status back when the server refuses", async () => {
    const qc = seeded()
    show(qc, <PartStatusPicker part={PART} />)
    fireEvent.click(await screen.findByRole("radio", { name: /Spare/ }))
    await waitFor(() =>
      expect(everywhere(qc)).toEqual(["Spare", "Spare", "Spare", "Spare"])
    )
    patch.reject(new ApiError(403, { detail: "You do not have permission." }))
    await waitFor(() =>
      expect(everywhere(qc)).toEqual(["Active", "Active", "Active", "Active"])
    )
  })
})

describe("a hardware marker on a photo panel", () => {
  // As the rack page and a cabinet hand it in: the marker's part from the
  // face payload, no parts list of its own.
  const panel = () => (
    <ImagePortsFaceplate
      deviceTypeId="t-srv"
      deviceId="d1"
      device={{ name: "srv-1", image_ports: null }}
      facePorts={face(ACTIVE)}
      interfaces={[]}
      side="front"
    />
  )
  const marker = () =>
    waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-slot="hover-card-trigger"]'
      )
      if (!el) throw new Error("no marker yet")
      return el
    })

  it("offers the statuses on its card and on a right-click", async () => {
    const qc = seeded()
    show(qc, panel())
    const disk4 = await marker()
    fireEvent.focus(disk4)
    expect(
      await screen.findByRole("radiogroup", { name: "Status of disk4" })
    ).not.toBeNull()
    fireEvent.contextMenu(disk4, { clientX: 40, clientY: 60 })
    expect(await screen.findByText("disk4 · Status")).not.toBeNull()
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Failed" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/inventory-items/p1/", {
        method: "PATCH",
        body: JSON.stringify({ status_id: "s-fail" }),
      })
    )
  })

  it("shows the status as a pill, and no menu, to a user who can't change it", async () => {
    allowed.value = false
    const qc = seeded()
    show(qc, panel())
    const disk4 = await marker()
    fireEvent.focus(disk4)
    // Radix writes a hover card's text once; the pill is the status's own.
    expect(await screen.findByText("Active")).not.toBeNull()
    expect(screen.queryByRole("radiogroup")).toBeNull()
    fireEvent.contextMenu(disk4, { clientX: 40, clientY: 60 })
    expect(screen.queryByText("disk4 · Status")).toBeNull()
  })
})

describe("in 3D", () => {
  it("puts the statuses on a part's card", async () => {
    const qc = seeded()
    show(
      qc,
      <PortHud
        device={{ id: "d1", name: "srv-1" }}
        position="R1 · U5"
        selection={{
          kind: "port",
          tileId: "t1",
          deviceId: "d1",
          portName: "disk4",
          portKind: "inventory-item",
          portSide: "front",
        }}
      />
    )
    const group = await screen.findByRole("radiogroup", {
      name: "Status of disk4",
    })
    expect(group.textContent).toContain("Failed")
  })

  it("opens a part's statuses at the pointer on a right-click", async () => {
    const qc = seeded()
    show(
      qc,
      <PartMarkerMenu
        menu={{ x: 10, y: 20, deviceId: "d1", marker: "disk4", side: "front" }}
        onClose={() => {}}
      />
    )
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Spare" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/inventory-items/p1/", {
        method: "PATCH",
        body: JSON.stringify({ status_id: "s-spare" }),
      })
    )
  })
})
