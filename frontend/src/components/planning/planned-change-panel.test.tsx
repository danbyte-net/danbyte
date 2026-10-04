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

import type { PlanningPlannedChange, PlanningTask } from "@/lib/api"
import { PlannedChangePanel } from "./planned-change-panel"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: vi.fn(() => Promise.resolve({})),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))
vi.mock("@/lib/custom-fields", () => ({
  useCustomizationMeta: () => ({ data: undefined }),
}))
vi.mock("./object-chip", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ObjectRow: () => <div />,
}))

/**
 * Applying a planned change goes through the generic planning endpoint, so the
 * site-write scan in lib/site-cache.test.ts can't see it. A planned site or
 * region edit must still drop the map payloads, or the site map keeps drawing
 * the old colour (#250).
 */
const change = (
  over: Partial<PlanningPlannedChange>
): PlanningPlannedChange => ({
  id: "pc1",
  task: "t1",
  kind: "update",
  object_type: "api.site",
  object_id: "s1",
  payload: { color: "#00ff00" },
  before: { color: "#ff0000" },
  display: [{ field: "color", label: "Colour", from: "red", to: "green" }],
  created_object_id: null,
  planned_for: null,
  effective_date: null,
  state: "planned",
  note: "",
  stale: false,
  created_by_username: null,
  applied_at: null,
  applied_by_username: null,
  ...over,
})

const applyOne = async (c: PlanningPlannedChange) => {
  const qc = new QueryClient()
  const stale = (key: unknown[]) => qc.getQueryState(key)?.isInvalidated
  for (const key of [
    ["site-map"],
    ["site", "s1"],
    ["region", "r1"],
    ["devices"],
    ["interfaces"],
  ])
    qc.setQueryData(key, {})
  render(
    <QueryClientProvider client={qc}>
      <PlannedChangePanel
        task={{ planned_changes: [c] } as unknown as PlanningTask}
        canEdit
      />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: /Apply|Create now/ }))
  // Every apply drops the interface lists, so this marks the refresh as done.
  await waitFor(() => expect(stale(["interfaces"])).toBe(true))
  return stale
}

afterEach(cleanup)

describe("applying a planned change", () => {
  it("refetches the site views after a site edit", async () => {
    const stale = await applyOne(change({}))
    expect(stale(["site-map"])).toBe(true)
    expect(stale(["site", "s1"])).toBe(true)
    expect(stale(["devices"])).toBe(false)
  })

  it("refetches the site views after a region edit", async () => {
    const stale = await applyOne(
      change({ object_type: "api.region", object_id: "r1" })
    )
    expect(stale(["site-map"])).toBe(true)
    expect(stale(["region", "r1"])).toBe(true)
  })

  it("refetches the site views after a planned site create", async () => {
    const stale = await applyOne(change({ kind: "create", object_id: null }))
    expect(stale(["site-map"])).toBe(true)
  })

  it("leaves the site views alone for other objects", async () => {
    const stale = await applyOne(
      change({ object_type: "api.device", object_id: "d1" })
    )
    expect(stale(["site-map"])).toBe(false)
  })
})
