// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SnmpBindingControl } from "./snmp-binding-control"

// A Radix Select inside a <form> mirrors itself into a hidden native <select>
// so browser/extension autofill works - and forwards that select's change
// events into onValueChange. Autofill runs on page load with no user gesture
// and picks a row, which used to be saved as a real change: reloading the
// site edit page silently cleared the stored binding (#125). These pin the
// guard: a change with no user activation behind it must not reach the API.

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

function putCalls() {
  return apiMock.mock.calls.filter(([, init]) => init?.method === "PUT")
}

async function renderInForm() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const utils = render(
    <QueryClientProvider client={qc}>
      <form>
        <SnmpBindingControl scope="site" objectId="s1" canEdit />
      </form>
    </QueryClientProvider>
  )
  // The autofill bridge: Radix's hidden native select, present because the
  // control sits inside a <form>. It stays disabled until the binding query
  // hydrates (part of the same fix - nothing may fire pre-hydration).
  const hidden = await waitFor(() => {
    const el = utils.container.querySelector("select")
    if (!el || el.disabled) throw new Error("not hydrated")
    return el
  })
  return { ...utils, hidden }
}

describe("SnmpBindingControl autofill guard", () => {
  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/api/monitoring/snmp-binding/"))
        return Promise.resolve({
          scope: "site",
          object_id: "s1",
          profile_id: "p1",
          profile_name: "Public",
          effective: null,
        })
      if (path.startsWith("/api/monitoring/snmp-profile-options/"))
        return Promise.resolve({
          results: [{ id: "p1", name: "Public", version: "v2c" }],
        })
      return Promise.resolve({})
    })
  })
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "userActivation")
  })

  it("ignores a change with no user activation (autofill on load)", async () => {
    setActivation(false)
    const { hidden } = await renderInForm()
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(putCalls()).toHaveLength(0)
  })

  it("saves the same change when a real gesture is active", async () => {
    setActivation(true)
    const { hidden } = await renderInForm()
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await waitFor(() => expect(putCalls()).toHaveLength(1))
  })
})
