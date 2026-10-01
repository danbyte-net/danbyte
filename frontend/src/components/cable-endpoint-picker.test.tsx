// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { CableEndpointPicker } from "./cable-endpoint-picker"

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
})
