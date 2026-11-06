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

import type * as Api from "@/lib/api"
import type { DeviceProfileAssignment } from "@/lib/api"
import { AssignObjectsDialog, bulkAssignToast } from "./device-profile-bulk"

// "Assign devices" on a profile's page: the shared device and VM pickers in
// bulk mode, the objects already carrying the profile left out, every pick
// assigned through bulk/ in inline-sized batches, and a toast with what was
// assigned and what was skipped and why.

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: toastMock }))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, can: () => true }),
}))

type PickerProps = {
  label: string
  excludeIds?: string[]
  onPickMany?: (items: { id: string; label: string }[]) => void
}
/** A stand-in for the shared picker: shows what it leaves out and hands
 * over the ids its button names. */
function fakePicker(prefix: string, count: number) {
  return function Picker({ label, excludeIds, onPickMany }: PickerProps) {
    const items = Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${i + 1}`,
      label: `${prefix}-name-${i + 1}`,
    })).filter((x) => !excludeIds?.includes(x.id))
    return (
      <div>
        <span data-testid={`${label}-excluded`}>
          {(excludeIds ?? []).join(",")}
        </span>
        <button type="button" onClick={() => onPickMany?.(items)}>
          Pick all {label}
        </button>
      </div>
    )
  }
}
let deviceCount = 3
vi.mock("@/components/device-picker", () => ({
  DevicePicker: (p: PickerProps) => fakePicker("d", deviceCount)(p),
}))
vi.mock("@/components/vm-picker", () => ({
  VMPicker: (p: PickerProps) => fakePicker("v", 2)(p),
}))

beforeEach(() => {
  apiMock.mockReset()
  toastMock.success.mockReset()
  toastMock.warning.mockReset()
  deviceCount = 3
})
afterEach(cleanup)

const assigned = (over: Partial<DeviceProfileAssignment>) =>
  ({
    id: "a1",
    device: null,
    virtual_machine: null,
    ...over,
  }) as DeviceProfileAssignment

function mount(applies = { devices: true, vms: true }) {
  const onOpenChange = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <AssignObjectsDialog
        profile={{
          id: "p1",
          applies_to_devices: applies.devices,
          applies_to_vms: applies.vms,
        }}
        assigned={[
          assigned({ device: { id: "d1", name: "d-name-1" } }),
          assigned({
            id: "a2",
            virtual_machine: { id: "v2", name: "v-name-2" },
          }),
        ]}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>
  )
  return { onOpenChange }
}

const bodies = () =>
  apiMock.mock.calls.map(([p, init]) => ({
    path: p,
    body: JSON.parse(String(init?.body)),
  }))

describe("AssignObjectsDialog", () => {
  it("leaves assigned objects out and assigns devices and VMs", async () => {
    apiMock.mockImplementation(async (_p, init) => {
      const b = JSON.parse(String(init?.body))
      if (b.device_ids)
        return {
          results: [
            { id: "d2", name: "d-name-2", outcome: "assigned" },
            {
              id: "d3",
              name: "",
              outcome: "denied",
              detail:
                "Missing permission at this object's site: add device profile assignment.",
            },
          ],
          counts: { assigned: 1, denied: 1 },
        }
      return {
        results: [{ id: "v1", name: "v-name-1", outcome: "assigned" }],
        counts: { assigned: 1 },
      }
    })
    const { onOpenChange } = mount()
    expect(screen.getByTestId("Devices-excluded").textContent).toBe("d1")
    fireEvent.click(screen.getByRole("button", { name: "Pick all Devices" }))
    fireEvent.click(screen.getByRole("button", { name: "Virtual machines" }))
    expect(screen.getByTestId("Virtual machines-excluded").textContent).toBe(
      "v2"
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Pick all Virtual machines" })
    )
    expect(screen.getByText("d-name-2")).toBeTruthy()
    expect(screen.getByText("v-name-1")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Assign 3" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(bodies()).toEqual([
      {
        path: "/api/device-profile-assignments/bulk/",
        body: { profile_id: "p1", action: "assign", device_ids: ["d2", "d3"] },
      },
      {
        path: "/api/device-profile-assignments/bulk/",
        body: {
          profile_id: "p1",
          action: "assign",
          virtual_machine_ids: ["v1"],
        },
      },
    ])
    expect(toastMock.warning).toHaveBeenCalledWith(
      "Assigned 2 · skipped 1",
      expect.objectContaining({
        description: expect.stringContaining("Missing permission"),
      })
    )
  })

  it("sends a long pick in batches the server answers inline", async () => {
    deviceCount = 31
    apiMock.mockImplementation(async (_p, init) => {
      const ids: string[] = JSON.parse(String(init?.body)).device_ids
      return {
        results: ids.map((id) => ({ id, name: id, outcome: "assigned" })),
        counts: { assigned: ids.length },
      }
    })
    mount({ devices: true, vms: false })
    // Only devices: no Devices | VMs switch.
    expect(
      screen.queryByRole("button", { name: "Virtual machines" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Pick all Devices" }))
    fireEvent.click(screen.getByRole("button", { name: "Assign 30" }))
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Assigned 30")
    )
    expect(bodies().map((c) => c.body.device_ids.length)).toEqual([25, 5])
  })

  it("can't assign until something is picked", () => {
    mount()
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Assign" }).disabled
    ).toBe(true)
  })
})

describe("bulkAssignToast", () => {
  it("groups the skipped by reason", () => {
    bulkAssignToast([
      { id: "a", name: "a", outcome: "unchanged", detail: "Already assigned." },
      { id: "b", name: "b", outcome: "unchanged", detail: "Already assigned." },
      {
        id: "c",
        name: "c",
        outcome: "refused",
        detail: "RDS is not for devices.",
      },
    ])
    expect(toastMock.warning).toHaveBeenCalledWith("Assigned 0 · skipped 3", {
      description: "Already assigned. a, b\nRDS is not for devices. c",
    })
  })
})
