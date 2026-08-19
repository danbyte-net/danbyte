// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PendingFieldsProvider } from "@/lib/pending-fields"
import { KvCard } from "@/components/kv-card"

// The device Overview's exact shape: one provider, one KvCard, a planned
// change per field - every marked label must grow its calendar-clock.
vi.mock("@/lib/save-object", () => ({
  usePlanTarget: () => null,
}))

vi.mock("@/lib/api", async (orig) => {
  const mod = await orig()
  return {
    ...(mod as object),
    api: vi.fn().mockResolvedValue({
      results: [
        {
          id: "1",
          task: "t1",
          state: "planned",
          effective_date: null,
          display: [
            { field: "description", label: "Description", from: "-", to: "x" },
          ],
        },
        {
          id: "2",
          task: "t1",
          state: "planned",
          effective_date: null,
          display: [
            { field: "status_id", label: "Status", from: "Active", to: "Off" },
            { field: "position", label: "Position", from: "27", to: "40" },
          ],
        },
      ],
    }),
  }
})

afterEach(cleanup)

describe("pending-field marks on a KvCard", () => {
  it("marks every field a planned change names, FK fields included", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <PendingFieldsProvider objectType="api.device" objectId="d1">
          <KvCard
            title="Device"
            rows={[
              { label: "Name", value: "sw1" },
              { label: "Status", value: "Active" },
              { label: "Description", value: "x" },
              // The form's unit-suffixed label must match the registry's
              // bare "Position" - the rack-elevation mark regression.
              { label: "Position (U)", value: "U27" },
            ]}
          />
        </PendingFieldsProvider>
      </QueryClientProvider>
    )
    await waitFor(() => {
      expect(
        screen.getAllByLabelText("A change to this field is planned")
      ).toHaveLength(3)
    })
  })
})
