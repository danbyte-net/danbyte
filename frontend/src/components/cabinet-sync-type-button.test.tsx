// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Cabinet, CabinetSyncDiff } from "@/lib/api"
import { CabinetSyncTypeButton } from "./cabinet-sync-type-button"

// Sync from type is a dry run first: the dialog lists the sizes and rails
// the type would change, and only Apply writes. Rails the type does not name
// are listed and left alone.

const { canDo } = vi.hoisted(() => ({ canDo: vi.fn(() => true) }))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canDo }) }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const TYPE = {
  id: "t1",
  numid: 1,
  name: "AE 1060.500",
  manufacturer: { id: "m1", name: "Rittal" },
  inner_width_mm: 525,
  inner_height_mm: 625,
  outer_width_mm: 600,
  outer_height_mm: 700,
  outer_depth_mm: 210,
}

const cabinet = (patch: Partial<Cabinet> = {}): Cabinet => ({
  id: "c1",
  numid: 1,
  name: "K1",
  facility_id: "",
  site: { id: "s1", name: "HQ" },
  location: null,
  role: null,
  cabinet_type: TYPE,
  status: null,
  inner_width_mm: 525,
  inner_height_mm: 600,
  outer_width_mm: 600,
  outer_height_mm: 700,
  outer_depth_mm: 210,
  rails: [],
  description: "",
  document_count: 0,
  tags: [],
  custom_fields: {},
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...patch,
})

const DRIFT: CabinetSyncDiff = {
  sizes: { inner_height_mm: { cabinet: 600, type: 625 } },
  rails: {
    add: ["R3"],
    update: [
      {
        label: "R1",
        changes: {
          y_mm: { cabinet: 80, type: 75 },
          profile: { cabinet: "ts15", type: "ts35" },
        },
      },
    ],
    extra: ["X1"],
  },
}

let calls: { url: string; body: Record<string, unknown> }[] = []
let diff: CabinetSyncDiff = DRIFT

beforeEach(() => {
  calls = []
  diff = DRIFT
  canDo.mockReturnValue(true)
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ url, body })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            applied: !!body.apply,
            diff: body.apply ? {} : diff,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    })
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderButton(c: Cabinet = cabinet()) {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <CabinetSyncTypeButton cabinet={c} />
    </QueryClientProvider>
  )
}

async function openPreview() {
  fireEvent.click(screen.getByRole("button", { name: "Sync from type" }))
  return screen.findByRole("dialog")
}

describe("CabinetSyncTypeButton", () => {
  it("is only offered on a cabinet with a type, to whoever may change it", () => {
    const { container } = renderButton(cabinet({ cabinet_type: null }))
    expect(container.textContent).toBe("")
    cleanup()
    canDo.mockReturnValue(false)
    expect(renderButton().container.textContent).toBe("")
  })

  it("shows what the type would change before applying it", async () => {
    renderButton()
    const dialog = await openPreview()
    expect(calls[0]).toEqual({
      url: "/api/cabinets/c1/sync-from-type/",
      body: {},
    })
    const text = dialog.textContent
    expect(text).toContain("Sync with Rittal AE 1060.500")
    expect(text).toContain("Plate height600 mm→ 625 mm")
    expect(text).toContain("AddR3")
    expect(text).toContain("R1 profileTS 15→ TS 35")
    expect(text).toContain("R1 centreline80 mm→ 75 mm")
    expect(text).toContain("Not on the type, keptX1")

    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].body).toEqual({ apply: true, sizes: true, rails: true })
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Synced - added R3 · moved R1 · 1 size"
      )
    )
  })

  it("leaves out the part that is unticked", async () => {
    renderButton()
    await openPreview()
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply sizes" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].body).toEqual({ apply: true, sizes: false, rails: true })
  })

  it("says so when the cabinet matches its type", async () => {
    diff = { rails: { add: [], update: [], extra: ["X1"] } }
    renderButton()
    const dialog = await openPreview()
    expect(dialog.textContent).toContain("This cabinet matches its type.")
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull()
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBe(2)
  })
})
