// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LearnedMacsCell } from "./learned-macs-cell"
import type { InterfaceMacs, LearnedMac, PortMacs } from "@/lib/api"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
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

const SOURCE = { deviceId: "d1", view: "member" as const }

const mac = (n: number, extra: Partial<LearnedMac> = {}): LearnedMac => ({
  mac: `3c:52:82:aa:10:${String(n).padStart(2, "0")}`,
  vendor: { name: "Hewlett Packard", source: "ieee" },
  vlans: [10],
  ips: [{ ip: `10.10.3.${n}`, id: null }],
  name: `pc-0${n}.corp.local`,
  name_source: "dns_record",
  first_seen: "2026-09-21T04:02:00Z",
  last_seen: "2026-10-03T13:50:00Z",
  here: true,
  location: null,
  ...extra,
})

const port = (extra: Partial<PortMacs> = {}): PortMacs => ({
  interface_id: "if-9",
  interface_name: "Gi1/0/9",
  device_id: "d1",
  port_name: "Gi1/0/9",
  port_key: "gi1/0/9",
  if_index: "10",
  uplink: { is: false, mode: "auto", reasons: [] },
  count: 2,
  located: 2,
  macs: [mac(41), mac(42)],
  ...extra,
})

function mount(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

afterEach(cleanup)
beforeEach(() => apiMock.mockReset())

describe("LearnedMacsCell", () => {
  it("is a dash without learned MACs", () => {
    const { container } = mount(
      <LearnedMacsCell port={undefined} source={SOURCE} />
    )
    expect(container.textContent).toBe("-")
    cleanup()
    const empty = mount(
      <LearnedMacsCell port={port({ count: 0, macs: [] })} source={SOURCE} />
    )
    expect(empty.container.textContent).toBe("-")
  })

  it("lists each MAC with its short name and IP", () => {
    mount(<LearnedMacsCell port={port()} source={SOURCE} />)
    expect(screen.getByText("3c:52:82:aa:10:41")).toBeTruthy()
    expect(screen.getByText("pc-041 · 10.10.3.41")).toBeTruthy()
    expect(screen.getByText("pc-042 · 10.10.3.42")).toBeTruthy()
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it("points a MAC that sits elsewhere at its location", () => {
    mount(
      <LearnedMacsCell
        port={port({
          count: 1,
          macs: [
            mac(43, {
              here: false,
              location: {
                kind: "access",
                device: { id: "d7", name: "sw-acc-07" },
                interface: { id: "if-12", name: "Gi1/0/12" },
                port_name: "Gi1/0/12",
              },
            }),
          ],
        })}
        source={SOURCE}
      />
    )
    expect(screen.getByText("sw-acc-07")).toBeTruthy()
    expect(screen.getByText("Gi1/0/12")).toBeTruthy()
    expect(screen.queryByText(/pc-043/)).toBeNull()
  })

  it("opens the full list behind +N more", async () => {
    const all = [mac(41), mac(42), mac(43), mac(44), mac(45)]
    apiMock.mockResolvedValue({ ports: [port({ count: 5, macs: all })] })
    mount(<LearnedMacsCell port={port({ count: 5 })} source={SOURCE} />)
    fireEvent.click(screen.getByRole("button", { name: "+3 more" }))
    expect(await screen.findByText("3c:52:82:aa:10:45")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith(
      "/api/monitoring/devices/d1/macs/?view=member&limit=0"
    )
    expect(screen.getByText("5 MACs")).toBeTruthy()
  })

  it("shows an uplink as a badge and a count, never a list", async () => {
    const through: InterfaceMacs = {
      interface: {
        id: "if-te",
        name: "Te1/1/1",
        device: { id: "d1", name: "sw-acc-03" },
      },
      uplink: {
        is: true,
        mode: "auto",
        reasons: [
          {
            code: "lldp",
            text: "LLDP neighbour sw-core-01",
            neighbor: "sw-core-01",
          },
        ],
      },
      counts: { present: 1, all: 1 },
      read_at: null,
      stale: false,
      state: "present",
      next_cursor: null,
      results: [
        {
          id: "s1",
          mac: "98:fa:9b:d0:bd:0f",
          vendor: null,
          vlan: 11,
          vlan_object: null,
          ips: [],
          name: "lt-2440",
          name_source: "dhcp_lease",
          first_seen: "2026-09-21T04:02:00Z",
          last_seen: "2026-10-03T13:50:00Z",
          gone_at: null,
          state: "present",
          stale: false,
          here: false,
          location: {
            kind: "access",
            device: { id: "d5", name: "sw-acc-05" },
            interface: null,
            port_name: "Gi1/0/36",
          },
        },
      ],
    }
    apiMock.mockResolvedValue(through)
    mount(
      <LearnedMacsCell
        port={port({
          interface_id: "if-te",
          interface_name: "Te1/1/1",
          port_name: "Te1/1/1",
          uplink: through.uplink,
          count: 358,
          located: 0,
          macs: [],
        })}
        source={SOURCE}
      />
    )
    expect(screen.getByText("Uplink")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "358 MACs" }))
    expect(await screen.findByText("98:fa:9b:d0:bd:0f")).toBeTruthy()
    expect(screen.getByText("sw-acc-05")).toBeTruthy()
    expect(screen.getByText("Gi1/0/36")).toBeTruthy()
    expect(apiMock.mock.calls[0][0]).toContain(
      "/api/monitoring/interfaces/if-te/macs/?state=present"
    )
  })
})
