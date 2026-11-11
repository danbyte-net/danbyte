// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { PendingHostKey } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { credentialSourceLabel } from "@/components/columns/inventory-columns"
import { HostKeysPanel } from "./host-keys-panel"
import { RunNowDialog } from "./run-now-dialog"
import { RunStatusBadge } from "./status"

// Discovery at scale (#451): the host-key review, the Run now opt-in and
// the run outcome wording.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/components/table-filters", () => ({
  useUrlTableFilters: <TCols, TRows>(columns: TCols, rows: TRows) => ({
    rail: null,
    filteredRows: rows,
    columns,
  }),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => () => undefined,
  useSearch: () => ({}),
  useRouterState: () => ({ location: { search: {} } }),
}))

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

function key(over: Partial<PendingHostKey>): PendingHostKey {
  return {
    id: "k1",
    device: { id: "d1", name: "web1" },
    virtual_machine: null,
    address: "10.0.0.1",
    key_type: "ssh-ed25519",
    fingerprint: "SHA256:abc",
    first_seen: "2026-11-10T00:00:00Z",
    last_seen: "2026-11-10T00:00:00Z",
    mismatch: false,
    can_accept: true,
    ...over,
  }
}

beforeEach(() => apiMock.mockReset())
afterEach(cleanup)

describe("run outcome", () => {
  it("shows Nothing read as a warning, not a failure", () => {
    render(<RunStatusBadge status="nothing_read" />)
    expect(screen.getByText("Nothing read").dataset.variant).toBe("warning")
  })

  it("names where a login came from", () => {
    expect(credentialSourceLabel("host")).toBe("Host's own")
    expect(credentialSourceLabel("shared: ops")).toBe("Shared · ops")
  })
})

describe("Run now", () => {
  it("starts unticked and sends the choice", () => {
    const onRun = vi.fn()
    wrap(
      <RunNowDialog
        open
        onOpenChange={() => undefined}
        profileName="Linux"
        firstUseAllowed
        canAcceptKeys
        pending={false}
        onRun={onRun}
      />
    )
    const box = screen.getByRole("checkbox", { name: /Accept new host keys/ })
    expect(box.getAttribute("aria-checked")).toBe("false")
    expect(screen.getByText(/Not advised/)).toBeTruthy()
    fireEvent.click(box)
    fireEvent.click(screen.getByRole("button", { name: "Run now" }))
    expect(onRun).toHaveBeenCalledWith(true)
  })

  it("disables the box without key rights and hides it when locked", () => {
    const { unmount } = wrap(
      <RunNowDialog
        open
        onOpenChange={() => undefined}
        profileName="Linux"
        firstUseAllowed
        canAcceptKeys={false}
        pending={false}
        onRun={() => undefined}
      />
    )
    expect(
      screen
        .getByRole("checkbox", { name: /Accept new host keys/ })
        .hasAttribute("disabled")
    ).toBe(true)
    unmount()
    wrap(
      <RunNowDialog
        open
        onOpenChange={() => undefined}
        profileName="Linux"
        firstUseAllowed={false}
        canAcceptKeys
        pending={false}
        onRun={() => undefined}
      />
    )
    expect(screen.queryByText(/Accept new host keys/)).toBeNull()
  })
})

describe("host keys to review", () => {
  it("flags a changed key and never sends it", async () => {
    apiMock.mockImplementation((path) =>
      Promise.resolve(
        path === "/api/me/"
          ? { perms: [], permissions: {} }
          : String(path).includes("/accept/")
            ? { accepted: ["k1"], refused: [], not_found: 0 }
            : {
                count: 2,
                results: [
                  key({}),
                  key({
                    id: "k2",
                    fingerprint: "SHA256:changed",
                    mismatch: true,
                    can_accept: false,
                  }),
                ],
              }
      )
    )
    wrap(
      <HostKeysPanel
        endpoint="/api/discovery/runs/r1/host-keys/"
        queryKey={["k"]}
      />
    )
    await waitFor(() =>
      expect(screen.getByText("Differs from accepted key")).toBeTruthy()
    )
    for (const box of screen.getAllByRole("checkbox", { name: /select row/i }))
      fireEvent.click(box)
    const btn = screen.getByRole("button", { name: "Accept 1 key" })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/discovery/host-keys/accept/",
        expect.objectContaining({ body: JSON.stringify({ ids: ["k1"] }) })
      )
    )
  })
})
