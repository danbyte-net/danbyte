// @vitest-environment jsdom
import { Suspense } from "react"
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { MacEntry } from "@/lib/api"
import { Route } from "./macs.index"

// A search that matches no MAC must not leave a selection behind (#251):
// the table stays mounted, so the rows filtered away leave the selection
// and the bulk bar goes with them - Remove can never act on rows that are
// neither visible nor ticked.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
// The page's chrome is not under test: the shell keeps its search box and
// children, the header actions and dialogs render nothing.
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    search,
    children,
  }: {
    search: { value: string; onChange: (v: string) => void }
    children: ReactNode
  }) => (
    <div>
      <input
        aria-label="Search"
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
      />
      {children}
    </div>
  ),
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))
vi.mock("@/components/mac-object-dialog", () => ({
  MacObjectDialog: () => null,
}))
vi.mock("@/components/oui-ranges-dialog", () => ({
  OuiRangesDialog: () => null,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const entry = (mac: string): MacEntry => ({
  mac,
  vendor: null,
  interfaces: [],
  vm_interfaces: [],
  ips: [],
  objects: [],
})
const MACS = ["aa:00:00:00:00:01", "aa:00:00:00:00:02", "aa:00:00:00:00:03"]

afterEach(cleanup)
// The route's component is code-split: load it once up front.
beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})
let listed: MacEntry[] = []
beforeEach(() => {
  listed = MACS.map(entry)
  apiMock.mockReset()
  // The list, and an empty answer for the table's own preference reads.
  apiMock.mockImplementation((path) =>
    Promise.resolve(
      path === "/api/macs/" ? { count: listed.length, results: listed } : {}
    )
  )
})

function mount() {
  const Page = Route.options.component as React.ComponentType
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </QueryClientProvider>
  )
}

const rowOf = (mac: string) => screen.getByText(mac).closest("tr")!
const tick = (mac: string) =>
  fireEvent.click(within(rowOf(mac)).getByRole("checkbox"))
const search = (text: string) =>
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: text },
  })
const removeButton = () => screen.queryByRole("button", { name: /Remove/ })

describe("MAC list selection", () => {
  it("drops the selection when a search matches nothing", async () => {
    mount()
    await screen.findByText(MACS[0])
    tick(MACS[0])
    tick(MACS[1])
    expect(removeButton()).toBeTruthy()

    search("no-such-mac")
    expect(screen.getByText("No results.")).toBeTruthy()
    expect(removeButton()).toBeNull()

    search("")
    await screen.findByText(MACS[0])
    const ticked = screen
      .getAllByRole("checkbox")
      .filter((b) => b.getAttribute("data-state") === "checked")
    expect(ticked).toEqual([])
    expect(removeButton()).toBeNull()
  })

  it("says the list is empty only when there are no MACs at all", async () => {
    listed = []
    mount()
    expect(await screen.findByText(/No MAC addresses yet/)).toBeTruthy()
  })
})
