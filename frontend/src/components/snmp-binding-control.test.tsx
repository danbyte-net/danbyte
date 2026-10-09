// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  BindingDraftsProvider,
  useBindingDraftsRoot,
} from "@/lib/binding-drafts"
import type { BindingDrafts } from "@/lib/binding-drafts"
import { SnmpBindingControl } from "./snmp-binding-control"

// A Radix Select inside a <form> mirrors itself into a hidden native <select>
// so browser/extension autofill works - and forwards that select's change
// events into onValueChange. Autofill runs on page load with no user gesture
// and picks a row, which used to be saved as a real change: reloading the
// site edit page silently cleared the stored binding (#125). The mirror also
// reports a change on its own when the controlled value has no <option> yet
// (binding answered before the profile list): it settles on "" and that was
// written as the binding merely by opening the form (#324). These pin both
// guards: nothing is written without a gesture, before hydration, or for a
// value that is not an offered row.

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
  profile_id: "p1",
  profile_name: "Public",
  effective: null,
}
const PROFILES = {
  results: [
    { id: "p1", name: "Public", version: "v2c" },
    { id: "p2", name: "Secure", version: "v3" },
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
        <SnmpBindingControl scope="site" objectId="s1" canEdit />
      </form>
    </QueryClientProvider>
  )
}

// The autofill bridge: Radix's hidden native select, present because the
// control sits inside a <form>. It exists only once both queries hydrated.
async function hydrated(container: HTMLElement) {
  return waitFor(() => {
    const el = container.querySelector("select")
    if (!el || el.disabled) throw new Error("not hydrated")
    return el
  })
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))

function mockResolved() {
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return Promise.resolve(BINDING)
    if (path.startsWith("/api/monitoring/snmp-binding/"))
      return Promise.resolve(BINDING)
    if (path.startsWith("/api/monitoring/snmp-profile-options/"))
      return Promise.resolve(PROFILES)
    return Promise.resolve({})
  })
}

describe("SnmpBindingControl autofill guard", () => {
  beforeEach(() => {
    apiMock.mockReset()
    mockResolved()
  })
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "userActivation")
  })

  it("ignores a change with no user activation (autofill on load)", async () => {
    setActivation(false)
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    hidden.value = "p2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    expect(putCalls()).toHaveLength(0)
  })

  it("saves the same change when a real gesture is active", async () => {
    setActivation(true)
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    hidden.value = "p2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    expect(putBodies()).toEqual([{ profile_id: "p2" }])
  })
})

describe("SnmpBindingControl load-then-save ordering", () => {
  beforeEach(() => {
    apiMock.mockReset()
    // The page was reached by a click moments ago: activation is live.
    setActivation(true)
  })
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "userActivation")
  })

  it("renders the shared loading state, not a select, until both queries resolve", async () => {
    const binding = deferred<typeof BINDING>()
    const profiles = deferred<typeof PROFILES>()
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/api/monitoring/snmp-binding/")
        ? binding.promise
        : profiles.promise
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
      profiles.resolve(PROFILES)
    })
    const hidden = await hydrated(container)
    expect(hidden.value).toBe("p1")
    expect(putCalls()).toHaveLength(0)
  })

  it("never writes when the binding answers before the profile list", async () => {
    const profiles = deferred<typeof PROFILES>()
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/api/monitoring/snmp-binding/")
        ? Promise.resolve(BINDING)
        : profiles.promise
    )
    const { container } = renderInForm()
    await tick()
    await tick()
    expect(putCalls()).toHaveLength(0)
    await act(async () => {
      profiles.resolve(PROFILES)
    })
    const hidden = await hydrated(container)
    await tick()
    expect(hidden.value).toBe("p1")
    expect(putCalls()).toHaveLength(0)
  })

  it("never writes when the stored profile is not among the offered ones", async () => {
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/api/monitoring/snmp-binding/")
        ? Promise.resolve({ ...BINDING, profile_id: "gone" })
        : Promise.resolve(PROFILES)
    )
    const { container } = renderInForm()
    await hydrated(container)
    await tick()
    await tick()
    expect(putCalls()).toHaveLength(0)
  })

  it("does not write a value that is not an offered option", async () => {
    mockResolved()
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    Object.defineProperty(hidden, "value", { configurable: true, value: "" })
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    expect(putCalls()).toHaveLength(0)
  })
})

describe("SnmpBindingControl inside an edit form", () => {
  let drafts: BindingDrafts | null = null

  function Form() {
    const root = useBindingDraftsRoot()
    drafts = root
    return (
      <form>
        <BindingDraftsProvider value={root}>
          <SnmpBindingControl scope="site" objectId="s1" canEdit />
        </BindingDraftsProvider>
      </form>
    )
  }

  beforeEach(() => {
    apiMock.mockReset()
    setActivation(true)
    mockResolved()
  })
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "userActivation")
  })

  it("stages a pick until the form saves, then writes it once", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <Form />
      </QueryClientProvider>
    )
    const hidden = await hydrated(container)
    hidden.value = "p2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    expect(putCalls()).toHaveLength(0)
    await act(async () => {
      await drafts!.commit()
    })
    expect(putBodies()).toEqual([{ profile_id: "p2" }])
  })
})
