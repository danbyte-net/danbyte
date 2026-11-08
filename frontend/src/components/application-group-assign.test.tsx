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
import type { ApplicationGroupAssignment } from "@/lib/api"
import {
  AssignGroupDialog,
  releaseSummary,
  UnassignGroupDialog,
} from "./application-group-assign"

// Application groups on a host (#436): Assign posts the group and the host,
// Unassign deletes the assignment and says what became of its installs.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("@/lib/save-object", async (orig) => ({
  ...(await orig<object>()),
  usePlanTarget: () => null,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))
vi.mock("@/components/application-group-picker", () => ({
  ApplicationGroupPicker: ({
    onChange,
    excludeIds,
  }: {
    onChange: (v: string) => void
    excludeIds?: string[]
  }) => (
    <button type="button" onClick={() => onChange("grp-1")}>
      Pick RDS{excludeIds?.length ? ` without ${excludeIds.join(",")}` : ""}
    </button>
  ),
}))

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({ count: 0, results: [] })
})
afterEach(cleanup)

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const assignment = {
  id: "as-1",
  group: { id: "grp-1", name: "RDS", slug: "rds" },
  device: null,
  virtual_machine: { id: "v1", name: "vm1" },
  install_count: 2,
  created_at: "2026-10-25T10:00:00Z",
} as ApplicationGroupAssignment

describe("AssignGroupDialog", () => {
  it("assigns the picked group to the tab's VM", async () => {
    apiMock.mockResolvedValue(assignment)
    const onOpenChange = vi.fn()
    wrap(
      <AssignGroupDialog
        host={{ kind: "vm", id: "v1" }}
        assignedGroupIds={["grp-0"]}
        open
        onOpenChange={onOpenChange}
      />
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Pick RDS without grp-0" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/application-group-assignments/")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({
      group_id: "grp-1",
      virtual_machine_id: "v1",
    })
  })
})

describe("UnassignGroupDialog", () => {
  it("deletes the assignment", async () => {
    apiMock.mockResolvedValue({ removed: 1, kept: 1, moved: 0 })
    const onOpenChange = vi.fn()
    wrap(
      <UnassignGroupDialog
        assignment={assignment}
        onOpenChange={onOpenChange}
      />
    )
    expect(screen.getByText("Unassign RDS from vm1?")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Unassign" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(apiMock).toHaveBeenCalledWith(
      "/api/application-group-assignments/as-1/",
      { method: "DELETE" }
    )
  })
})

describe("releaseSummary", () => {
  it("names only what happened", () => {
    expect(releaseSummary({ removed: 2, kept: 0, moved: 0 })).toBe("2 removed")
    expect(releaseSummary({ removed: 0, kept: 1, moved: 1 })).toBe(
      "1 kept · 1 moved to another group"
    )
  })
})
