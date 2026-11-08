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
import type { ApplicationGroup } from "@/lib/api"
import { MemberDialog } from "./application-groups.$id"

// Adding a parent application to a group (#436): the dialog offers its
// children, counted without the ones already in the group, and sends
// include_children with the parent's row.

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
vi.mock("@/components/application-picker", () => ({
  ApplicationPicker: ({ onChange }: { onChange: (v: string) => void }) => (
    <>
      <button type="button" onClick={() => onChange("platform")}>
        Pick platform
      </button>
      <button type="button" onClick={() => onChange("redis")}>
        Pick redis
      </button>
    </>
  ),
}))

// The checkbox measures itself; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const app = (id: string) => ({ id, name: id, slug: id, path: id, depth: 1 })

const group = {
  id: "g1",
  name: "Web",
  slug: "web",
  members: [{ id: "m1", application: app("postgres"), version: "16" }],
} as unknown as ApplicationGroup

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation(async (path: string) =>
    path.includes("ancestor=platform")
      ? {
          count: 3,
          results: ["danbyte", "postgres", "python"].map((id) => ({
            ...app(id),
            child_count: 0,
          })),
        }
      : { count: 0, results: [] }
  )
})
afterEach(cleanup)

function renderDialog(onSave = vi.fn(async () => undefined)) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <MemberDialog
        group={group}
        member={null}
        open
        onOpenChange={() => {}}
        onSave={onSave}
      />
    </QueryClientProvider>
  )
  return onSave
}

describe("MemberDialog include children", () => {
  it("offers the children of a parent and sends include_children", async () => {
    const onSave = renderDialog()
    fireEvent.click(screen.getByText("Pick platform"))
    const box = await screen.findByText("Include children")
    expect(box.parentElement?.textContent).toContain("2")
    const submit = screen.getByRole("button", { name: "Add 3 applications" })
    fireEvent.click(submit)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]).toEqual([
      [
        { application_id: "postgres", version: "16" },
        { application_id: "platform", version: "", include_children: true },
      ],
    ])
  })

  it("adds the parent alone when unticked", async () => {
    const onSave = renderDialog()
    fireEvent.click(screen.getByText("Pick platform"))
    fireEvent.click(await screen.findByText("Include children"))
    fireEvent.click(screen.getByRole("button", { name: "Add application" }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]).toEqual([
      [
        { application_id: "postgres", version: "16" },
        { application_id: "platform", version: "" },
      ],
    ])
  })

  it("shows no checkbox for an application without children", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("Pick redis"))
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([path]) => path.includes("ancestor=redis"))
      ).toBe(true)
    )
    expect(screen.queryByText("Include children")).toBeNull()
    expect(screen.getByRole("button", { name: "Add application" })).toBeTruthy()
  })
})
