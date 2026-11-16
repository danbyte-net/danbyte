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
import type { DependencyProposal } from "@/lib/api"
import { SuggestDependenciesDialog } from "./suggest-dialog"

// The review dialog of "Suggest from cables and LLDP" (#450): it asks the
// server for proposals from the core device, lists them with checkboxes,
// and creates the ticked ones - a refused row stays with its reason, a
// created one leaves the list.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
  ResizeObserverStub

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useRouterState: () => ({}),
  useSearch: () => ({}),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ canDo: () => true, me: {} }),
}))
vi.mock("@/components/device-picker", () => ({
  DevicePicker: ({ label, value }: { label: string; value: string | null }) => (
    <div>
      {label}: {value}
    </div>
  ),
}))

const end = (id: string, name: string) => ({ id, name, site: null })
const proposal = (
  up: [string, string],
  down: [string, string],
  over: Partial<DependencyProposal> = {}
): DependencyProposal => ({
  key: `${up[0]}:${down[0]}`,
  upstream: end(...up),
  downstream: end(...down),
  distance: 1,
  direction: "distance",
  evidence: "cable",
  medium_guess: "ethernet",
  medium: null,
  redundancy_group: "",
  ports: [],
  ...over,
})

const SUGGEST = "/api/device-dependencies/suggest/"
const CONFIRM = "/api/device-dependencies/suggest/confirm/"
const CYCLE = "This would make a cycle: acc-7 → core-1 → dist-2 → acc-7."

beforeEach(() => apiMock.mockReset())
afterEach(cleanup)

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SuggestDependenciesDialog
        open
        onOpenChange={() => {}}
        core={{ id: "core", name: "core-1" }}
      />
    </QueryClientProvider>
  )
}

describe("SuggestDependenciesDialog", () => {
  it("lists the proposals, creates the ticked ones, keeps a refused row", async () => {
    apiMock.mockImplementation(async (path, init) => {
      if (path === SUGGEST)
        return {
          core: end("core", "core-1"),
          max_depth: 8,
          reached: 3,
          skipped_existing: 1,
          truncated: false,
          proposals: [
            proposal(["core", "core-1"], ["dist", "dist-2"], {
              evidence: "lldp",
            }),
            proposal(["dist", "dist-2"], ["acc", "acc-7"], {
              distance: 2,
              redundancy_group: "auto-core-1",
            }),
          ],
        }
      if (path !== CONFIRM) return {}
      const rows = JSON.parse(String(init?.body)).rows
      expect(rows).toHaveLength(2)
      return {
        created: 1,
        results: [
          { index: 0, ok: true, id: "new" },
          { index: 1, ok: false, errors: { upstream_id: [CYCLE] } },
        ],
      }
    })
    renderDialog()
    expect(screen.getByText("Core device: core")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Find" }))
    expect(
      await screen.findAllByText("dist-2", { selector: "a" })
    ).toHaveLength(2)
    const call = (path: string) => apiMock.mock.calls.find((c) => c[0] === path)
    expect(JSON.parse(String(call(SUGGEST)?.[1]?.body))).toEqual({
      core_device: "core",
      max_depth: 8,
      use_lldp: true,
    })
    expect(
      screen.getByText("3 devices reached · 1 already related")
    ).toBeTruthy()
    expect(
      screen.getByText("LLDP", { selector: "[data-slot=badge]" })
    ).toBeTruthy()
    expect(screen.getByText("auto-core-1")).toBeTruthy()

    // Nothing is created until rows are ticked.
    const create = () => screen.getByRole("button", { name: /Create selected/ })
    expect((create() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    await waitFor(() =>
      expect(create().textContent).toBe("Create selected (2)")
    )
    fireEvent.click(create())

    expect(await screen.findByText(CYCLE)).toBeTruthy()
    expect(JSON.parse(String(call(CONFIRM)?.[1]?.body)).rows[1]).toEqual({
      upstream_id: "dist",
      downstream_id: "acc",
      medium_id: null,
      redundancy_group: "auto-core-1",
    })
    // The created proposal left the list; the refused one stays.
    expect(screen.queryByText("core-1", { selector: "a" })).toBeNull()
    expect(screen.getByText("acc-7", { selector: "a" })).toBeTruthy()
  })

  it("says so when there is nothing to suggest", async () => {
    apiMock.mockImplementation(async (path) =>
      path !== SUGGEST
        ? {}
        : {
            core: end("core", "core-1"),
            max_depth: 8,
            reached: 1,
            skipped_existing: 0,
            truncated: false,
            proposals: [],
          }
    )
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Find" }))
    expect(await screen.findByText("Nothing to suggest.")).toBeTruthy()
  })
})
