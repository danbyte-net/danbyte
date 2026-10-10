// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { MacEntry } from "@/lib/api"
import {
  attachments,
  MacBulkRemoveDialog,
  mergeRemovals,
  optionPlan,
  removalSummary,
} from "./mac-bulk-bar"
import type { MacBulkRemoveResult } from "./mac-bulk-bar"

// Removing MACs from the list (#251): the dialog's counts come from the
// server's dry run, an option the user may not use stays off, Remove sends
// only the options that are on, and each MAC shows what it is attached to.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))

afterEach(cleanup)

const plan = (
  permitted: boolean,
  count: number,
  skipped = 0,
  applied = false
) => ({ permitted, count, skipped, applied })

const preview: MacBulkRemoveResult = {
  dry_run: true,
  macs: 2,
  sources: {
    objects: plan(true, 12, 1),
    interfaces: plan(true, 3),
    vm_interfaces: plan(false, 0, 2),
    ips: plan(false, 0, 7),
  },
}

const mac = (m: string, over: Partial<MacEntry> = {}): MacEntry => ({
  mac: m,
  vendor: null,
  interfaces: [],
  vm_interfaces: [],
  ips: [],
  objects: [],
  location: null,
  ...over,
})
const dev = (name: string) => ({ id: name, name })
const ON_SWITCH = mac("aa:bb:cc:00:00:01", {
  interfaces: [{ id: "i1", name: "eth0", device: dev("sw1") }],
  vm_interfaces: [{ id: "v1", name: "nic0", vm: dev("vm1") }],
  ips: [{ id: "p1", ip_address: "10.0.0.5", device: null }],
})
const LOOSE = mac("aa:bb:cc:00:00:02")

let posted: Record<string, unknown>[] = []
beforeEach(() => {
  posted = []
  apiMock.mockReset()
  apiMock.mockImplementation((_path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    posted.push(body)
    if (body.dry_run) return Promise.resolve(preview)
    return Promise.resolve({
      ...preview,
      dry_run: false,
      sources: { ...preview.sources, objects: plan(true, 12, 1, true) },
    })
  })
})

function mount(onDone = vi.fn(), macs = [ON_SWITCH, LOOSE]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MacBulkRemoveDialog
        macs={macs}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>
  )
  return onDone
}

describe("optionPlan", () => {
  it("adds device and VM interfaces up for the interface option", () => {
    expect(optionPlan(preview, "clear_interfaces")).toEqual({
      permitted: true,
      count: 3,
      skipped: 2,
    })
    expect(optionPlan(preview, "unpair_ips")).toEqual({
      permitted: false,
      count: 0,
      skipped: 7,
    })
  })
})

describe("attachments", () => {
  it("lists interfaces, then IPs, and counts the rest", () => {
    expect(attachments(ON_SWITCH)).toBe("sw1:eth0, vm1:nic0, 10.0.0.5")
    expect(attachments(ON_SWITCH, 2)).toBe("sw1:eth0, vm1:nic0 +1")
    expect(attachments(LOOSE)).toBe("")
  })
})

describe("removalSummary", () => {
  it("names only what was applied", () => {
    const res: MacBulkRemoveResult = {
      dry_run: false,
      macs: 1,
      sources: {
        objects: plan(true, 1, 0, true),
        interfaces: plan(true, 2, 0, true),
        vm_interfaces: plan(true, 1, 0, true),
        ips: plan(true, 4, 0, false),
      },
    }
    expect(removalSummary(res)).toBe(
      "Deleted 1 MAC object, cleared 3 interfaces."
    )
  })
})

describe("MacBulkRemoveDialog", () => {
  it("shows the dry-run counts and keeps an ungranted option off", async () => {
    mount()
    expect(await screen.findByText("Delete 12 MAC objects")).toBeTruthy()
    expect(screen.getByText("Clear from 3 interfaces")).toBeTruthy()
    expect(screen.getByText("Unpair from 0 IP addresses")).toBeTruthy()
    expect(screen.getByText("1 outside your permissions")).toBeTruthy()
    expect(screen.getByText("No permission")).toBeTruthy()

    const boxes = screen.getAllByRole("checkbox")
    expect(boxes[0].getAttribute("data-state")).toBe("checked")
    expect(boxes[1].getAttribute("data-state")).toBe("unchecked")
    expect(boxes[2].hasAttribute("disabled")).toBe(true)
    expect(posted[0]).toMatchObject({ dry_run: true })
  })

  it("shows what each MAC is attached to", async () => {
    mount()
    await screen.findByText("Delete 12 MAC objects")
    const row = screen.getByText("aa:bb:cc:00:00:01").closest("li")!
    expect(row.textContent).toContain("sw1:eth0, vm1:nic0, 10.0.0.5")
    const loose = screen.getByText("aa:bb:cc:00:00:02").closest("li")!
    expect(loose.textContent).toContain("-")
  })

  it("sends only the options that are on", async () => {
    const onDone = mount()
    await screen.findByText("Delete 12 MAC objects")
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(posted.at(-1)).toEqual({
      values: ["aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02"],
      remove_objects: true,
      clear_interfaces: false,
      unpair_ips: false,
    })
  })

  it("holds Remove back when every option is off", async () => {
    mount()
    await screen.findByText("Delete 12 MAC objects")
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    const remove = screen.getByRole("button", { name: "Remove" })
    expect(remove.hasAttribute("disabled")).toBe(true)
  })

  // More MACs than one call takes (#286) go 2000 at a time: the counts add
  // up, and Remove shows the batch on its way.
  it("asks and removes in batches of 2000", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => mac(`02:00:${i}`))
    // The first removal waits here, so the button is seen mid-run.
    const gate: { open?: () => void } = {}
    let removals = 0
    apiMock.mockImplementation((_path, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      posted.push(body)
      if (body.dry_run) return Promise.resolve(preview)
      const done = Promise.resolve({
        ...preview,
        dry_run: false,
        sources: { ...preview.sources, objects: plan(true, 12, 1, true) },
      })
      removals += 1
      if (removals > 1) return done
      return new Promise((resolve) => {
        gate.open = () => resolve(done)
      })
    })
    const onDone = mount(vi.fn(), many)
    expect(await screen.findByText("Delete 24 MAC objects")).toBeTruthy()
    expect(screen.getByText("2 outside your permissions")).toBeTruthy()
    expect(posted.map((b) => (b.values as string[]).length)).toEqual([
      2000, 500,
    ])

    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(
      await screen.findByRole("button", { name: "Removing… 1 / 2" })
    ).toBeTruthy()
    gate.open?.()
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const writes = posted.filter((b) => !b.dry_run)
    expect(writes.map((b) => (b.values as string[]).length)).toEqual([
      2000, 500,
    ])
    expect(writes[1]).toMatchObject({
      remove_objects: true,
      clear_interfaces: false,
      unpair_ips: false,
    })
  })
})

describe("mergeRemovals", () => {
  it("adds each source up over the batches", () => {
    const second: MacBulkRemoveResult = {
      dry_run: true,
      macs: 1,
      sources: {
        objects: plan(true, 1),
        interfaces: plan(true, 0, 4),
        vm_interfaces: plan(false, 0, 1),
        ips: plan(false, 0),
      },
    }
    expect(mergeRemovals([preview, second])).toEqual({
      dry_run: true,
      macs: 3,
      sources: {
        objects: plan(true, 13, 1),
        interfaces: plan(true, 3, 4),
        vm_interfaces: plan(false, 0, 3),
        ips: plan(false, 0, 7),
      },
    })
  })
})
