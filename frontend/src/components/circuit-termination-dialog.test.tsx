// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type {
  CircuitTermination,
  CircuitTerminationWritePayload,
} from "@/lib/api"
import { CircuitTerminationDialog } from "./circuit-termination-dialog"
import { CircuitEndCell } from "./cells/circuit-end-cell"

// A circuit end lands on a device port by cable, or on a VM interface picked
// in the dialog (#432). The dialog sends the VM interface, or null for a
// device port; the VM page names the circuit on the interface.

const { apiMock, saveMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  saveMock: vi.fn<(args: { payload: unknown }) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/save-object", async (orig) => ({
  ...(await orig<object>()),
  useSaveObject: () => saveMock,
  usePlanTarget: () => null,
}))
vi.mock("@/components/vm-picker", () => ({
  VMPicker: ({ onChange }: { onChange: (v: string | null) => void }) => (
    <button type="button" onClick={() => onChange("vm1")}>
      pick chr-a
    </button>
  ),
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
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

beforeEach(() => {
  apiMock.mockReset()
  saveMock.mockReset()
  saveMock.mockResolvedValue({})
  apiMock.mockImplementation((path) => {
    if (path.startsWith("/api/sites/"))
      return page([{ id: "s1", name: "SiteA" }])
    if (path.startsWith("/api/vm-interfaces/?vm=vm1"))
      return page([
        { id: "vi1", name: "ether1" },
        { id: "vi2", name: "ether2" },
      ])
    return page([])
  })
})
afterEach(cleanup)

const TERM = {
  id: "t1",
  term_side: "Z",
  cable: null,
  connected_to: null,
  site: { id: "s1", name: "SiteA" },
  provider_network: null,
  vm_interface: { id: "vi1", name: "ether1", vm: { id: "vm1", name: "chr-a" } },
  port_speed_kbps: null,
  upstream_speed_kbps: null,
  xconnect_id: "",
  pp_info: "",
  description: "",
  created_at: "",
  updated_at: "",
} as unknown as CircuitTermination

function renderDialog(termination?: CircuitTermination) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <CircuitTerminationDialog
        circuitId="c1"
        termination={termination ?? null}
        presetSide={termination ? null : "Z"}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
}

function field(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "label" }).closest("div.grid")
  if (!(el instanceof HTMLElement)) throw new Error(`no field ${label}`)
  return el
}

function submit() {
  const button = screen.getByRole("button", {
    name: /Add termination|Save changes/,
  })
  fireEvent.submit(button.closest("form") as HTMLFormElement)
}

function sent(): CircuitTerminationWritePayload {
  const call = saveMock.mock.calls.at(0)
  if (!call) throw new Error("nothing was sent")
  return call[0].payload as CircuitTerminationWritePayload
}

describe("CircuitTerminationDialog landing", () => {
  it("lands on a device port by default and sends no VM interface", async () => {
    renderDialog()
    expect(
      screen
        .getByRole("button", { name: "Device port" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    expect(screen.queryByText("VM interface", { selector: "label" })).toBeNull()
    fireEvent.click(within(field("Site")).getByRole("combobox"))
    fireEvent.click(await screen.findByRole("option", { name: "SiteA" }))
    submit()
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(sent().site_id).toBe("s1")
    expect(sent().vm_interface_id).toBeNull()
  })

  it("picks a VM, then its interface, and leaves the site to the VM", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "VM interface" }))
    fireEvent.click(screen.getByRole("button", { name: "pick chr-a" }))
    fireEvent.click(within(field("VM interface")).getByRole("combobox"))
    fireEvent.click(await screen.findByRole("option", { name: "ether1" }))
    submit()
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(sent().vm_interface_id).toBe("vi1")
    expect(sent().site_id).toBeNull()
  })

  it("will not submit a VM landing without an interface", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "VM interface" }))
    submit()
    await new Promise((r) => setTimeout(r, 0))
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("edits an end on a VM interface, and moving it to a device port clears it", async () => {
    renderDialog(TERM)
    expect(
      screen
        .getByRole("button", { name: "VM interface" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    submit()
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(sent().vm_interface_id).toBe("vi1")

    saveMock.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Device port" }))
    submit()
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(sent().vm_interface_id).toBeNull()
    expect(sent().site_id).toBe("s1")
  })
})

describe("CircuitEndCell", () => {
  it("names the circuit and the side", () => {
    render(
      <CircuitEndCell
        end={{ id: "t1", side: "Z", circuit: { id: "c1", cid: "INET-1" } }}
      />
    )
    expect(screen.getByText("INET-1")).toBeTruthy()
    expect(screen.getByText("Z side")).toBeTruthy()
  })

  it("is a dash without a circuit", () => {
    const { container } = render(<CircuitEndCell end={null} />)
    expect(container.textContent).toBe("-")
  })
})
