// @vitest-environment jsdom
import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TopologyCardConfig } from "@/lib/api"
import {
  CardLinesDialog,
  CardLinesEditor,
  ViewCardLinesEditor,
} from "./card-lines-dialog"
import type { CardLinesTarget } from "./card-lines-dialog"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))
// The save goes through useSaveObject, which reads the location for plan
// mode; outside a plan it is a plain PATCH.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useRouterState: (opts: {
    select: (s: { location: { search: object } }) => unknown
  }) => opts.select({ location: { search: {} } }),
}))

// Radix's Switch measures itself; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const CONFIG: TopologyCardConfig = {
  fields: ["primary_ip", "loopback"],
  role_overrides: { "role:leaf": ["loopback"], "role:edge_fw": [] },
  source: "tenant",
  available: [
    "status",
    "monitor",
    "primary_ip",
    "secondary_ip",
    "oob_ip",
    "loopback",
    "serial",
    "tags",
  ],
  pills: ["status", "monitor"],
  defaults: ["monitor", "primary_ip", "loopback", "serial"],
  max_fields: 8,
}

/** The device's stored `topology_card`, as GET /api/devices/<id>/ has it. */
let stored: string[] | null = null

beforeEach(() => {
  stored = null
  apiMock.mockReset()
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path.startsWith("/api/custom-fields/"))
      return Promise.resolve({
        results: [
          { key: "rack_unit", label: "Rack unit", hidden: false },
          { key: "secret", label: "Secret", hidden: true },
        ],
      })
    if (path === "/api/topology-card/") return Promise.resolve(CONFIG)
    if (path === "/api/devices/d1/") {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          topology_card: string[] | null
        }
        return Promise.resolve({ id: "d1", topology_card: body.topology_card })
      }
      return Promise.resolve({ id: "d1", topology_card: stored })
    }
    return Promise.resolve({})
  })
})
afterEach(cleanup)

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** The editor as a form holds it: controlled, inside a <form>. */
function renderEditor(
  props: {
    initial?: string[] | null
    inherited?: string[]
    compact?: boolean
  } = {}
) {
  const changes: (string[] | null)[] = []
  const submit = vi.fn((e: React.FormEvent) => e.preventDefault())
  function Harness() {
    const [value, setValue] = useState<string[] | null>(props.initial ?? null)
    return (
      <form onSubmit={submit}>
        <CardLinesEditor
          value={value}
          onChange={(next) => {
            changes.push(next)
            setValue(next)
          }}
          config={CONFIG}
          inherited={props.inherited ?? CONFIG.fields}
          from="All devices"
          compact={props.compact}
        />
      </form>
    )
  }
  render(
    <QueryClientProvider client={client()}>
      <Harness />
    </QueryClientProvider>
  )
  return { changes, submit }
}

const tab = (name: string) => screen.getByRole("button", { name })
const nameOnly = () => screen.getByRole("switch", { name: "Name only" })

describe("CardLinesEditor", () => {
  it("previews the inherited lines, read-only, with where they come from", () => {
    renderEditor()
    expect(tab("Inherit").getAttribute("aria-current")).toBe("page")
    expect(screen.getByText("From All devices")).toBeTruthy()
    expect(screen.getByText("IP")).toBeTruthy()
    expect(screen.getByText("Loopback")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Remove IP" })).toBeNull()
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("starts Custom from the inherited list; Inherit sends null and keeps the edit", () => {
    const { changes } = renderEditor()
    fireEvent.click(tab("Custom"))
    expect(changes.at(-1)).toEqual(["primary_ip", "loopback"])
    expect(screen.getByText("2 of 8")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Remove Loopback" }))
    expect(changes.at(-1)).toEqual(["primary_ip"])

    fireEvent.click(tab("Inherit"))
    expect(changes.at(-1)).toBeNull()
    // Back to Custom: the list as it was left, not the inherited one.
    fireEvent.click(tab("Custom"))
    expect(changes.at(-1)).toEqual(["primary_ip"])
  })

  it("adds a line at the end, and offers visible custom fields only", () => {
    const { changes } = renderEditor({ initial: ["loopback"] })
    fireEvent.click(screen.getByRole("button", { name: "Serial" }))
    expect(changes.at(-1)).toEqual(["loopback", "serial"])
    return waitFor(() => {
      expect(screen.getByRole("button", { name: "Rack unit" })).toBeTruthy()
      expect(screen.queryByRole("button", { name: "Secret" })).toBeNull()
    })
  })

  it("makes Name only an explicit empty list, and puts the list back", () => {
    const { changes } = renderEditor({ initial: ["serial", "tags"] })
    fireEvent.click(nameOnly())
    expect(changes.at(-1)).toEqual([])
    expect(
      screen.getByText("The card shows just the device name.")
    ).toBeTruthy()
    expect(screen.getByText("0 of 8")).toBeTruthy()
    fireEvent.click(nameOnly())
    expect(changes.at(-1)).toEqual(["serial", "tags"])
  })

  it("turns Name only off onto the inherited list, else the defaults", () => {
    const first = renderEditor({ initial: [] })
    fireEvent.click(nameOnly())
    expect(first.changes.at(-1)).toEqual(CONFIG.fields)
    cleanup()

    const second = renderEditor({ initial: [], inherited: [] })
    fireEvent.click(nameOnly())
    expect(second.changes.at(-1)).toEqual(CONFIG.defaults)
  })

  it("never submits the form it sits in", () => {
    const { submit, changes } = renderEditor({ initial: ["serial", "tags"] })
    fireEvent.click(screen.getByRole("button", { name: "Move Serial down" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove Tags" }))
    fireEvent.click(tab("Inherit"))
    fireEvent.click(tab("Custom"))
    fireEvent.click(nameOnly())
    expect(changes).toEqual([
      ["tags", "serial"],
      ["serial"],
      null,
      ["serial"],
      [],
    ])
    expect(submit).not.toHaveBeenCalled()
  })

  it("compact: no hints, and the add picker opens on demand", () => {
    const { changes } = renderEditor({ initial: ["primary_ip"], compact: true })
    expect(screen.queryByText("Primary address")).toBeNull()
    expect(screen.queryByText("Addresses")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Add line" }))
    expect(screen.getByText("Addresses")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Loopback" }))
    expect(changes.at(-1)).toEqual(["primary_ip", "loopback"])
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.queryByText("Addresses")).toBeNull()
  })
})

describe("ViewCardLinesEditor", () => {
  it("inherits All devices and says how many roles differ", async () => {
    render(
      <QueryClientProvider client={client()}>
        <ViewCardLinesEditor value={null} onChange={() => {}} />
      </QueryClientProvider>
    )
    expect(await screen.findByText(/2 roles differ/)).toBeTruthy()
    expect(screen.getByText("IP")).toBeTruthy()
  })
})

describe("CardLinesDialog", () => {
  const LEAF: CardLinesTarget = {
    id: "d1",
    name: "leaf-1",
    role: { slug: "leaf", name: "Leaf", color: "10b981" },
  }

  function renderDialog(viewFields?: string[] | null) {
    const qc = client()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const onClose = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <CardLinesDialog
          target={LEAF}
          viewFields={viewFields}
          onClose={onClose}
        />
      </QueryClientProvider>
    )
    return { invalidate, onClose }
  }

  const patches = () =>
    apiMock.mock.calls
      .filter(([, init]) => init?.method === "PATCH")
      .map(([path, init]) => [path, JSON.parse(String(init?.body))])

  const save = () => screen.getByRole("button", { name: "Save" })

  it("inherits the role's lines and saves name only as []", async () => {
    const { invalidate, onClose } = renderDialog()
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText("Loopback")
    expect(within(dialog).getByText("leaf-1")).toBeTruthy()
    expect(within(dialog).getByText("Leaf")).toBeTruthy()
    expect(save().hasAttribute("disabled")).toBe(true)

    fireEvent.click(tab("Custom"))
    fireEvent.click(nameOnly())
    expect(save().hasAttribute("disabled")).toBe(false)
    fireEvent.click(save())

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(patches()).toEqual([["/api/devices/d1/", { topology_card: [] }]])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["topology"] })
  })

  it("inherits the view's own lines before the role's", async () => {
    renderDialog(["serial"])
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText("Serial")
    expect(within(dialog).getByText("From this view")).toBeTruthy()
    expect(within(dialog).queryByText("Loopback")).toBeNull()
  })

  it("puts a device with its own list back on inherit with null", async () => {
    stored = ["serial"]
    const { onClose } = renderDialog()
    await screen.findByText("1 of 8")
    expect(tab("Custom").getAttribute("aria-current")).toBe("page")
    fireEvent.click(tab("Inherit"))
    fireEvent.click(save())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(patches()).toEqual([["/api/devices/d1/", { topology_card: null }]])
  })
})
