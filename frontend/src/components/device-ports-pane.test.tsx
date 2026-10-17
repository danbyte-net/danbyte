// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AddActionsContext } from "@/components/device-add-actions"
import {
  DeviceFrontPortsPane,
  DeviceRearPortsPane,
} from "@/components/device-ports-pane"

// Front and rear ports are tabs of their own on the device page (#345), each
// a full table with the Columns menu, its saved layout and its own Add.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const base = {
  device: { id: "d1", name: "pp-01" },
  label: "",
  mark_connected: false,
  type: "lc",
  description: "",
  tags: [],
  cable: null,
  reservation: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
}
const REAR = [
  { ...base, id: "r1", name: "R1", positions: 12, front_port_count: 1 },
]
const FRONT = [
  {
    ...base,
    id: "f1",
    name: "F1",
    positions: 1,
    rear_port: { id: "r1", name: "R1", device: base.device, positions: 12 },
    rear_port_position: 3,
  },
]

const page = (results: unknown[]) => ({ count: results.length, results })
let prefPaths: string[] = []
beforeEach(() => {
  prefPaths = []
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.startsWith("/api/rear-ports/")) return Promise.resolve(page(REAR))
    if (path.startsWith("/api/front-ports/"))
      return Promise.resolve(page(FRONT))
    if (path.startsWith("/api/prefs/")) prefPaths.push(path)
    return Promise.resolve({})
  })
})
afterEach(cleanup)

function mount(node: ReactNode) {
  const adds: Record<string, string[]> = {}
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AddActionsContext.Provider
        value={(key, actions) => {
          adds[key] = actions.map((a) => a.label)
        }}
      >
        {node}
      </AddActionsContext.Provider>
    </QueryClientProvider>
  )
  return adds
}

describe("the device's port tabs", () => {
  it("rear ports: a full table with its own column layout", async () => {
    const adds = mount(<DeviceRearPortsPane deviceId="d1" />)
    const row = (await screen.findByText("R1")).closest("tr")!
    expect(within(row).getByText("12")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Columns/ })).toBeTruthy()
    expect(prefPaths.some((p) => p.includes("device-rear-ports"))).toBe(true)
    expect(adds["rear-ports"]).toEqual(["Rear port"])
    expect(apiMock).toHaveBeenCalledWith("/api/rear-ports/?device=d1")
  })

  it("front ports: the strand each maps to", async () => {
    const adds = mount(<DeviceFrontPortsPane deviceId="d1" />)
    const row = (await screen.findByText("F1")).closest("tr")!
    expect(within(row).getByText(/strand 3/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Columns/ })).toBeTruthy()
    expect(prefPaths.some((p) => p.includes("device-front-ports"))).toBe(true)
    expect(adds["front-ports"]).toEqual(["Front port"])
  })
})
