// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import type { SlaCheckGroup } from "@/lib/api"
import { SlaMemberDialog, membersAddedMessage } from "./sla-member-dialog"

const { toastSuccess, excluded } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  excluded: { current: [] as string[] | undefined },
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: vi.fn(() => Promise.resolve({ created: 2, skipped: 1 })),
}))
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}))
// The device picker stands in for its multi-pick hand-over.
vi.mock("@/components/device-picker", () => ({
  DevicePicker: (props: {
    excludeIds?: string[]
    onPickMany?: (items: { id: string; label: string }[]) => void
  }) => {
    excluded.current = props.excludeIds
    return (
      <button
        type="button"
        onClick={() =>
          props.onPickMany?.([
            { id: "d1", label: "leaf-1" },
            { id: "d2", label: "leaf-2" },
            { id: "d3", label: "leaf-3" },
          ])
        }
      >
        tick devices
      </button>
    )
  },
}))

afterEach(cleanup)

describe("membersAddedMessage", () => {
  it("counts what the bulk add did", () => {
    expect(membersAddedMessage(1, 0)).toBe("Member added")
    expect(membersAddedMessage(3, 0)).toBe("3 members added")
    expect(membersAddedMessage(2, 1)).toBe(
      "2 members added, 1 already in the group"
    )
    expect(membersAddedMessage(0, 1)).toBe("Already a member of that group")
    expect(membersAddedMessage(0, 4)).toBe("Already members of that group")
  })
})

describe("SlaMemberDialog multi-pick", () => {
  it("gathers ticked devices and adds them in one bulk call", async () => {
    const onAdded = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SlaMemberDialog
          agreementId="a1"
          groups={[{ id: "g1", name: "Leafs" } as SlaCheckGroup]}
          open
          onOpenChange={() => undefined}
          onAdded={onAdded}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "tick devices" }))
    expect(screen.getByText("leaf-1")).toBeTruthy()
    expect(excluded.current).toEqual(["d1", "d2", "d3"])
    // A chip comes off before the add.
    fireEvent.click(screen.getByRole("button", { name: "Remove leaf-2" }))
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    const [url, init] = vi.mocked(api).mock.calls[0]
    expect(url).toBe("/api/monitoring/sla-members/bulk-add/")
    expect(JSON.parse(String(init?.body))).toEqual({
      agreement: "a1",
      group: "g1",
      redundancy_group: "",
      monitor_ip: null,
      objects: [
        { object_type: "api.device", object_id: "d1" },
        { object_type: "api.device", object_id: "d3" },
      ],
    })
    expect(toastSuccess).toHaveBeenCalledWith(
      "2 members added, 1 already in the group"
    )
  })
})
