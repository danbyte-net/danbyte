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

import type { LayoutPreset } from "@/lib/layout-presets"

// The preset dialog: a new preset captures your layouts and its assignees;
// an edit can drop a table; the reset counts first and says how many it
// touches before anything is dropped.

const calls: { path: string; method: string; body: unknown }[] = []
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>()
  return {
    ...real,
    api: vi.fn((path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      calls.push({ path, method, body })
      const page = (results: unknown[]) =>
        Promise.resolve({
          count: results.length,
          next: null,
          previous: null,
          results,
        })
      if (path.startsWith("/api/people/groups/"))
        return page([{ id: 7, name: "noc" }])
      if (path.startsWith("/api/people/"))
        return page([{ id: 3, username: "ana", display_name: "Ana" }])
      if (path === "/api/prefs/columns/")
        return Promise.resolve({
          devices: { source: "user", is_forced: false, has_user_row: true },
          dashboard: { source: "user", is_forced: false, has_user_row: true },
        })
      if (path.endsWith("/reset/"))
        return Promise.resolve({
          dry_run: body?.dry_run,
          users: 4,
          tables: 2,
          layouts: 6,
        })
      return Promise.resolve({ ...PRESET, ...(body ?? {}) })
    }),
  }
})

vi.mock("@/lib/save-object", async (orig) => ({
  ...(await orig<object>()),
  usePlanTarget: () => null,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

import { PresetDialog } from "./layout-presets-card"

const PRESET: LayoutPreset = {
  id: "p1",
  name: "NOC view",
  description: "",
  everyone: false,
  weight: 100,
  users: [],
  groups: [{ id: 7, name: "noc" }],
  tables: {
    devices: { shown: 8, hidden: 3, pinned: 1 },
    prefixes: { shown: 5, hidden: 0, pinned: 0 },
  },
  updated_at: null,
  created_by: "admin",
}

afterEach(() => {
  cleanup()
  calls.length = 0
})

function mount(preset: LayoutPreset | null, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <PresetDialog preset={preset} onClose={onClose} />
    </QueryClientProvider>
  )
  return onClose
}

const writes = () => calls.filter((c) => c.method !== "GET")

describe("PresetDialog", () => {
  it("creates a preset from all my layouts with its assignees", async () => {
    const onClose = mount(null)
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Ops view" },
    })
    await screen.findByText("Ana")
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.click(screen.getByText("noc"))
    fireEvent.click(screen.getByText("Ana"))
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(writes()).toEqual([
      {
        path: "/api/prefs/presets/",
        method: "POST",
        body: {
          name: "Ops view",
          description: "",
          everyone: true,
          weight: 100,
          group_ids: [7],
          user_ids: [3],
          capture: "all",
        },
      },
    ])
  })

  it("lists the preset's tables with their counts and drops one on save", async () => {
    const onClose = mount(PRESET)
    expect(screen.getByText("8 shown")).toBeTruthy()
    expect(screen.getByText("1 pinned")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /^Remove Prefixes/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const [w] = writes()
    expect(w.method).toBe("PATCH")
    expect(w.path).toBe("/api/prefs/presets/p1/")
    expect(w.body).toMatchObject({ remove_tables: ["prefixes"] })
    expect(w.body).not.toHaveProperty("capture")
  })

  it("re-captures only the tables you tick", async () => {
    mount(PRESET)
    // The second "Devices" is the capture list's (the first is the
    // preset's own table row).
    await waitFor(() => expect(screen.getAllByText("Devices")).toHaveLength(2))
    fireEvent.click(screen.getAllByText("Devices")[1])
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toMatchObject({ capture: ["devices"] })
  })

  it("counts before resetting personal layouts, then resets", async () => {
    mount(PRESET)
    fireEvent.click(
      screen.getByRole("button", { name: "Reset personal layouts" })
    )
    expect(
      await screen.findByText(
        "6 saved layouts of 4 users across 2 tables go back to this preset."
      )
    ).toBeTruthy()
    expect(writes()).toHaveLength(1)
    expect(writes()[0].body).toEqual({ dry_run: true })
    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1].body).toEqual({ dry_run: false })
  })
})
