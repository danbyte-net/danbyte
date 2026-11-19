// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { useState } from "react"

import {
  CableEndpointPicker,
  portMatches,
  portNote,
} from "./cable-endpoint-picker"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
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
Element.prototype.scrollIntoView = () => {}

afterEach(cleanup)

const page = <T,>(results: T[]) => ({ count: results.length, results })

/** What the stubbed API answers, by path prefix; anything else stays
 * pending, so the panel's own lookups never land. */
const answers: Record<string, unknown> = {
  "/api/devices/sw1/": {
    id: "sw1",
    name: "access-sw1",
    device_type: { id: "dt", model: "C9300" },
  },
  "/api/interfaces/?device=sw1": page([
    { id: "i1", name: "Gi1/0/1", cable: { id: "c1" } },
    { id: "i2", name: "Gi1/0/2", cable: null, mark_connected: true },
    { id: "i3", name: "Gi1/0/3", cable: null },
    { id: "i7", name: "Gi1/0/7", cable: null, label: "Uplink core" },
    {
      id: "i8",
      name: "Gi1/0/8",
      cable: null,
      label: "",
      description: "Printer floor 2",
    },
  ]),
}

function renderPicker(onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CableEndpointPicker
        label="B side"
        value={[]}
        onChange={onChange}
        seedDeviceId="sw1"
      />
    </QueryClientProvider>
  )
  return onChange
}

describe("CableEndpointPicker", () => {
  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation((path: string) => {
      const hit = Object.keys(answers).find((k) => path.startsWith(k))
      return hit ? Promise.resolve(answers[hit]) : new Promise(() => {})
    })
  })

  it("lets a port marked connected be cabled, not one with a cable", async () => {
    const onChange = renderPicker()
    const marked = (await screen.findByText("Gi1/0/2")).closest("button")!
    expect(marked.disabled).toBe(false)
    expect(marked.textContent).toContain("marked connected")
    fireEvent.click(marked)
    expect(onChange).toHaveBeenCalledWith([{ kind: "interface", id: "i2" }])
    const cabled = screen.getByText("Gi1/0/1").closest("button")!
    expect(cabled.disabled).toBe(true)
    expect(cabled.textContent).toContain("already cabled")
  })

  it("shows a port's label, else its description, after the name", async () => {
    renderPicker()
    const labelled = (await screen.findByText("Gi1/0/7")).closest("button")!
    expect(labelled.textContent).toContain("Uplink core")
    const described = screen.getByText("Gi1/0/8").closest("button")!
    expect(described.textContent).toContain("Printer floor 2")
    const bare = screen.getByText("Gi1/0/3").closest("button")!
    expect(bare.textContent).toBe("Gi1/0/3")
  })

  it("filters ports by name, label or description", async () => {
    renderPicker()
    await screen.findByText("Gi1/0/7")
    const box = screen.getByPlaceholderText("Filter ports…")
    fireEvent.change(box, { target: { value: "uplink" } })
    expect(screen.getByText("Gi1/0/7")).toBeTruthy()
    expect(screen.queryByText("Gi1/0/3")).toBeNull()
    fireEvent.change(box, { target: { value: "printer" } })
    expect(screen.getByText("Gi1/0/8")).toBeTruthy()
    expect(screen.queryByText("Gi1/0/7")).toBeNull()
  })

  it("carries the label onto the picked port's chip", async () => {
    function Wrapper() {
      const [value, setValue] = useState<Api.TerminationInput[]>([])
      return (
        <CableEndpointPicker
          label="B side"
          value={value}
          onChange={setValue}
          seedDeviceId="sw1"
        />
      )
    }
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <Wrapper />
      </QueryClientProvider>
    )
    fireEvent.click((await screen.findByText("Gi1/0/7")).closest("button")!)
    expect(screen.getAllByText("Uplink core")).toHaveLength(2)
  })
})

describe("portNote / portMatches", () => {
  it("prefers the label, falls back to the description, else nothing", () => {
    expect(portNote({ label: "A", description: "B" })).toBe("A")
    expect(portNote({ label: " ", description: "B" })).toBe("B")
    expect(portNote({})).toBe("")
  })

  it("matches the name, the label or the description", () => {
    const r = { name: "Gi1/0/7", label: "Uplink", description: "to core" }
    expect(portMatches(r, "gi1")).toBe(true)
    expect(portMatches(r, "UPLINK")).toBe(true)
    expect(portMatches(r, "core")).toBe(true)
    expect(portMatches(r, "printer")).toBe(false)
    expect(portMatches(r, "")).toBe(true)
  })
})
