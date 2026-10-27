// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Device, PrtgDeviceLink, VirtualMachine } from "@/lib/api"
import { DeviceDeleteDialog } from "@/components/device-delete-dialog"
import { VmDeleteDialog } from "@/components/vm-delete-dialog"
import { mountWithRouter } from "./prtg-test-utils"
import { prtgDeleteQuery } from "./delete-option"

// "Also remove from PRTG" in the device and VM delete dialogs: shown only
// for a linked object the user may write PRTG for; a device Danbyte did not
// create is paused instead unless "Delete it anyway" is confirmed by name.

const { apiMock, canDo } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canDo: vi.fn(() => true),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo, humanIds: false }),
}))

const DEVICE = { id: "d1", name: "edge-01", ip_count: 0 } as unknown as Device

function link(patch: Partial<PrtgDeviceLink> = {}): PrtgDeviceLink {
  return {
    id: "l1",
    connection: "c1",
    device: { id: "d1", name: "edge-01" },
    virtual_machine: null,
    objid: "2081",
    name: "edge-01 prtg",
    host: "10.0.0.1",
    probe_name: "Local Probe",
    group_path: "Lab",
    matched_by: "address",
    created_here: true,
    tagged: false,
    status_raw: 3,
    state: "up",
    sensor_counts: {},
    status_read_at: null,
    last_seen_at: null,
    url: "",
    maintenance_paused_at: null,
    maintenance_paused_until: null,
    maintenance_events: [],
    maintenance_note: "",
    delete_default_remove: false,
    ...patch,
  }
}

let deletes: string[] = []

function serve(links: PrtgDeviceLink[], answer: unknown = { prtg: [] }) {
  apiMock.mockImplementation((path, init) => {
    if (path === "/api/integrations/enabled/")
      return Promise.resolve({ prtg: true })
    if (init?.method === "DELETE") {
      deletes.push(path)
      return Promise.resolve(answer)
    }
    if (path.startsWith("/api/prtg/links/"))
      return Promise.resolve({
        count: links.length,
        next: null,
        previous: null,
        results: links,
      })
    return Promise.resolve({
      count: 0,
      next: null,
      previous: null,
      results: [],
    })
  })
}

const deleteButton = () => screen.getByRole("button", { name: "Delete" })

describe("prtgDeleteQuery", () => {
  it("sends nothing for keep, the mode and force otherwise", () => {
    expect(prtgDeleteQuery({ mode: "keep", force: false })).toBe("")
    expect(prtgDeleteQuery({ mode: "remove", force: false })).toBe(
      "?prtg=remove"
    )
    expect(prtgDeleteQuery({ mode: "remove", force: true })).toBe(
      "?prtg=remove&prtg_force=1"
    )
  })
})

describe("delete dialogs and PRTG", () => {
  beforeEach(() => {
    deletes = []
    canDo.mockReturnValue(true)
  })
  afterEach(() => {
    cleanup()
    apiMock.mockReset()
  })

  it("is hidden for an object PRTG has not got, and keeps PRTG", async () => {
    serve([])
    mountWithRouter(() => (
      <DeviceDeleteDialog device={DEVICE} onOpenChange={() => {}} />
    ))
    await screen.findByText("Delete edge-01?")
    expect(screen.queryByText("Also remove from PRTG")).toBeNull()
    fireEvent.click(deleteButton())
    await waitFor(() => expect(deletes).toEqual(["/api/devices/d1/"]))
  })

  it("is hidden without the PRTG write permission", async () => {
    canDo.mockImplementation(
      ((type: string) => type !== "prtgdevicelink") as () => boolean
    )
    serve([link()])
    mountWithRouter(() => (
      <DeviceDeleteDialog device={DEVICE} onOpenChange={() => {}} />
    ))
    await screen.findByText("Delete edge-01?")
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText("Also remove from PRTG")).toBeNull()
  })

  it("removes a device Danbyte created", async () => {
    serve([link()])
    mountWithRouter(() => (
      <DeviceDeleteDialog device={DEVICE} onOpenChange={() => {}} />
    ))
    fireEvent.click(await screen.findByText("Also remove from PRTG"))
    expect(screen.queryByText("Pause in PRTG instead")).toBeNull()
    fireEvent.click(deleteButton())
    await waitFor(() =>
      expect(deletes).toEqual(["/api/devices/d1/?prtg=remove"])
    )
  })

  it("follows the connection's default", async () => {
    serve([link({ delete_default_remove: true })])
    mountWithRouter(() => (
      <DeviceDeleteDialog device={DEVICE} onOpenChange={() => {}} />
    ))
    await screen.findByText("Also remove from PRTG")
    fireEvent.click(deleteButton())
    await waitFor(() =>
      expect(deletes).toEqual(["/api/devices/d1/?prtg=remove"])
    )
  })

  it("pauses someone else's device unless deleting anyway is confirmed", async () => {
    serve([link({ created_here: false })])
    mountWithRouter(() => (
      <DeviceDeleteDialog device={DEVICE} onOpenChange={() => {}} />
    ))
    fireEvent.click(await screen.findByText("Also remove from PRTG"))
    expect(screen.getByText("Pause in PRTG instead")).toBeTruthy()
    fireEvent.click(screen.getByText("Delete it anyway"))
    // Not until the PRTG device is confirmed by name.
    await waitFor(() =>
      expect((deleteButton() as HTMLButtonElement).disabled).toBe(true)
    )
    fireEvent.click(screen.getByText("Delete edge-01 prtg (2081) in PRTG"))
    await waitFor(() =>
      expect((deleteButton() as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(deleteButton())
    await waitFor(() =>
      expect(deletes).toEqual(["/api/devices/d1/?prtg=remove&prtg_force=1"])
    )
  })

  it("a VM sends the same choice", async () => {
    serve([link({ device: null, virtual_machine: { id: "v1", name: "vm" } })])
    const vm = { id: "v1", name: "vm" } as VirtualMachine
    mountWithRouter(() => <VmDeleteDialog vm={vm} onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByText("Also remove from PRTG"))
    fireEvent.click(deleteButton())
    await waitFor(() =>
      expect(deletes).toEqual(["/api/virtual-machines/v1/?prtg=remove"])
    )
  })
})
