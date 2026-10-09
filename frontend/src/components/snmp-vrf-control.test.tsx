// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SnmpVrfControl } from "./snmp-vrf-control"

// Same save-on-change select as the SNMP profile binding, same hidden
// native-select mirror inside a <form>: a value with no <option> yet (binding
// answered before the VRF list) settled it on "" and that was written as the
// binding merely by opening the site form (#324). Nothing renders until both
// queries are known, and only a pick of an offered row is saved.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

function setActivation(isActive: boolean) {
  Object.defineProperty(window.navigator, "userActivation", {
    configurable: true,
    value: { isActive, hasBeenActive: isActive },
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const BINDING = {
  scope: "site",
  object_id: "s1",
  vrf_id: "v1",
  vrf_name: "mgmt",
  effective: { id: "v1", name: "mgmt" },
}
const VRFS = {
  results: [
    { id: "v1", name: "mgmt" },
    { id: "v2", name: "prod" },
  ],
}

function putCalls() {
  return apiMock.mock.calls.filter(([, init]) => init?.method === "PUT")
}

function putBodies() {
  return putCalls().map(([, init]) => JSON.parse(String(init?.body)))
}

function renderInForm() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <form>
        <SnmpVrfControl scope="site" objectId="s1" canEdit />
      </form>
    </QueryClientProvider>
  )
}

async function hydrated(container: HTMLElement) {
  return waitFor(() => {
    const el = container.querySelector("select")
    if (!el || el.disabled) throw new Error("not hydrated")
    return el
  })
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))

describe("SnmpVrfControl load-then-save ordering", () => {
  beforeEach(() => {
    apiMock.mockReset()
    setActivation(true)
  })
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "userActivation")
  })

  it("renders the shared loading state until both queries resolve, writing nothing", async () => {
    const binding = deferred<typeof BINDING>()
    const vrfs = deferred<typeof VRFS>()
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/api/monitoring/snmp-vrf-binding/")
        ? binding.promise
        : vrfs.promise
    )
    const { container, getByRole } = renderInForm()
    await tick()
    expect(getByRole("status").textContent).toContain("Loading…")
    expect(container.querySelector("select")).toBeNull()

    await act(async () => {
      binding.resolve(BINDING)
    })
    await tick()
    expect(container.querySelector("select")).toBeNull()

    await act(async () => {
      vrfs.resolve(VRFS)
    })
    const hidden = await hydrated(container)
    await tick()
    expect(hidden.value).toBe("v1")
    expect(putCalls()).toHaveLength(0)
  })

  it("never writes when the stored VRF is not among the offered ones", async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/api/monitoring/snmp-vrf-binding/")
        ? Promise.resolve({ ...BINDING, vrf_id: "gone" })
        : Promise.resolve(VRFS)
    )
    const { container } = renderInForm()
    await hydrated(container)
    await tick()
    await tick()
    expect(putCalls()).toHaveLength(0)
  })

  it("writes a real pick of an offered VRF once, after hydration", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Promise.resolve(BINDING)
      return path.startsWith("/api/monitoring/snmp-vrf-binding/")
        ? Promise.resolve(BINDING)
        : Promise.resolve(VRFS)
    })
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    hidden.value = "v2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    expect(putBodies()).toEqual([{ vrf_id: "v2" }])
  })

  it("ignores a change with no user activation", async () => {
    setActivation(false)
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/api/monitoring/snmp-vrf-binding/")
        ? Promise.resolve(BINDING)
        : Promise.resolve(VRFS)
    )
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    hidden.value = "v2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    expect(putCalls()).toHaveLength(0)
  })
})
