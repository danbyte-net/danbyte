// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  BindingDraftsProvider,
  useBindingDraftsRoot,
} from "@/lib/binding-drafts"
import type { BindingDrafts } from "@/lib/binding-drafts"
import { MonitoringEngineField } from "./monitoring-engine-field"

// The engine select saves on change, and inside a <form> Radix mirrors it
// into a hidden native <select> whose change events feed onValueChange. That
// mirror fires whenever the controlled value changes - and when the value has
// no matching <option> yet (the binding answered before the engine list did,
// or names an engine no longer offered) the native select settles on "" and
// the control saw a change to Inherit. With the user's navigation click still
// counting as activation, that wrote the stored binding away merely by
// opening the site form (#324). These pin the ordering: nothing renders, and
// nothing is written, until both the binding and the options are known.

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

const ENGINES = {
  results: [
    { id: "e1", name: "Branch", enabled: true, is_local: false },
    { id: "e2", name: "Zabbix", enabled: true, is_local: false },
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
        <MonitoringEngineField scope="site" objectId="s1" />
      </form>
    </QueryClientProvider>
  )
}

/** The hidden native select once the control is hydrated and enabled. */
async function hydrated(container: HTMLElement) {
  return waitFor(() => {
    const el = container.querySelector("select")
    if (!el || el.disabled) throw new Error("not hydrated")
    return el
  })
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))

describe("MonitoringEngineField load-then-save ordering", () => {
  beforeEach(() => {
    apiMock.mockReset()
    // The page was reached by a click moments ago: activation is live.
    setActivation(true)
  })
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "userActivation")
  })

  it("shows the shared loading state and no select until both queries resolve", async () => {
    const binding = deferred<{ engine_id: string | null }>()
    const engines = deferred<typeof ENGINES>()
    apiMock.mockImplementation((path: string) =>
      path.includes("/engine-binding/") ? binding.promise : engines.promise
    )
    const { container, getByRole } = renderInForm()
    await tick()
    expect(getByRole("status").textContent).toContain("Loading…")
    expect(container.querySelector("select")).toBeNull()

    await act(async () => {
      binding.resolve({ engine_id: "e1" })
    })
    await tick()
    // One of two answered: still loading, still nothing to save from.
    expect(container.querySelector("select")).toBeNull()

    await act(async () => {
      engines.resolve(ENGINES)
    })
    const hidden = await hydrated(container)
    expect(hidden.value).toBe("e1")
    expect(putCalls()).toHaveLength(0)
  })

  it("never writes when the binding answers before the engine list", async () => {
    const engines = deferred<typeof ENGINES>()
    apiMock.mockImplementation((path: string) =>
      path.includes("/engine-binding/")
        ? Promise.resolve({ engine_id: "e1" })
        : engines.promise
    )
    const { container } = renderInForm()
    await tick()
    await tick()
    expect(putCalls()).toHaveLength(0)

    await act(async () => {
      engines.resolve(ENGINES)
    })
    const hidden = await hydrated(container)
    await tick()
    expect(hidden.value).toBe("e1")
    expect(putCalls()).toHaveLength(0)
  })

  it("never writes when the stored engine is not among the offered ones", async () => {
    apiMock.mockImplementation((path: string) =>
      path.includes("/engine-binding/")
        ? Promise.resolve({ engine_id: "gone" })
        : Promise.resolve(ENGINES)
    )
    const { container } = renderInForm()
    await hydrated(container)
    await tick()
    await tick()
    expect(putCalls()).toHaveLength(0)
  })

  it("ignores an autofill change with no user activation", async () => {
    setActivation(false)
    apiMock.mockImplementation((path: string) =>
      path.includes("/engine-binding/")
        ? Promise.resolve({ engine_id: "e1" })
        : Promise.resolve(ENGINES)
    )
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    hidden.value = "e2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    expect(putCalls()).toHaveLength(0)
  })

  it("writes a real pick of an offered engine once, after hydration", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Promise.resolve({ engine_id: "e2" })
      return path.includes("/engine-binding/")
        ? Promise.resolve({ engine_id: "e1" })
        : Promise.resolve(ENGINES)
    })
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    hidden.value = "e2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    expect(putBodies()).toEqual([{ engine_id: "e2" }])
  })

  it("does not write a value that is not an offered option", async () => {
    apiMock.mockImplementation((path: string) =>
      path.includes("/engine-binding/")
        ? Promise.resolve({ engine_id: "e1" })
        : Promise.resolve(ENGINES)
    )
    const { container } = renderInForm()
    const hidden = await hydrated(container)
    // A change the mirror can emit on its own: the native select settling on
    // "" because nothing matched. No user can pick that.
    Object.defineProperty(hidden, "value", { configurable: true, value: "" })
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    expect(putCalls()).toHaveLength(0)
  })
})

describe("MonitoringEngineField inside an edit form", () => {
  let drafts: BindingDrafts | null = null

  function Form() {
    const root = useBindingDraftsRoot()
    drafts = root
    return (
      <form>
        <BindingDraftsProvider value={root}>
          <MonitoringEngineField scope="site" objectId="s1" />
        </BindingDraftsProvider>
      </form>
    )
  }

  function renderForm() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    return render(
      <QueryClientProvider client={qc}>
        <Form />
      </QueryClientProvider>
    )
  }

  beforeEach(() => {
    apiMock.mockReset()
    drafts = null
    setActivation(true)
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Promise.resolve({ engine_id: "e2" })
      return path.includes("/engine-binding/")
        ? Promise.resolve({ engine_id: "e1" })
        : Promise.resolve(ENGINES)
    })
  })
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "userActivation")
  })

  it("stages a pick and writes it only when the form saves", async () => {
    const { container } = renderForm()
    const hidden = await hydrated(container)
    hidden.value = "e2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    expect(putCalls()).toHaveLength(0)

    await act(async () => {
      await drafts!.commit()
    })
    expect(putBodies()).toEqual([{ engine_id: "e2" }])

    // Written once: a second save has nothing left to send.
    await act(async () => {
      await drafts!.commit()
    })
    expect(putCalls()).toHaveLength(1)
  })

  it("opening and saving without a pick writes nothing", async () => {
    const { container } = renderForm()
    await hydrated(container)
    await tick()
    await act(async () => {
      await drafts!.commit()
    })
    expect(putCalls()).toHaveLength(0)
  })

  it("a pick back to the stored engine leaves nothing staged", async () => {
    const { container } = renderForm()
    const hidden = await hydrated(container)
    hidden.value = "e2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    hidden.value = "e1"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    await act(async () => {
      await drafts!.commit()
    })
    expect(putCalls()).toHaveLength(0)
  })

  it("keeps a failed write staged and throws so the form stays open", async () => {
    let fail = true
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return fail
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({ engine_id: "e2" })
      return path.includes("/engine-binding/")
        ? Promise.resolve({ engine_id: "e1" })
        : Promise.resolve(ENGINES)
    })
    const { container } = renderForm()
    const hidden = await hydrated(container)
    hidden.value = "e2"
    hidden.dispatchEvent(new Event("change", { bubbles: true }))
    await tick()
    await act(async () => {
      await expect(drafts!.commit()).rejects.toThrow("boom")
    })
    fail = false
    await act(async () => {
      await drafts!.commit()
    })
    expect(putBodies()).toEqual([{ engine_id: "e2" }, { engine_id: "e2" }])
  })
})
