// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { Tag, TagDuplicates } from "@/lib/api"
import { Route } from "./tags.index"

// The Tags page: a notice when visible names collide, a filter that lists
// the pairs, a "global" chip on deployment-global tags, and a Merge into…
// row action whose dialog says how many objects move.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) => apiMock(path),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    rail,
    summary,
    children,
  }: {
    rail?: ReactNode
    summary?: ReactNode
    children: ReactNode
  }) => (
    <div>
      {rail}
      {summary}
      {children}
    </div>
  ),
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
Element.prototype.scrollIntoView = () => {}

function tag(id: number, name: string, patch: Partial<Tag> = {}): Tag {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    color: "",
    text_color: "",
    usage_count: 0,
    owning_site: null,
    is_global: false,
    ...patch,
  }
}

const TAGS: Tag[] = [
  tag(1, "prod", { is_global: true, usage_count: 4 }),
  tag(2, "Prod", { usage_count: 3 }),
  tag(3, "core"),
  tag(4, "lab", { owning_site: { id: "s2", name: "Branch" } }),
]
const DUPS: TagDuplicates = {
  count: 1,
  results: [{ name: "prod", ids: [1, 2] }],
}

beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.startsWith("/api/tags/duplicates/")) return Promise.resolve(DUPS)
    if (path.includes("/merge/"))
      return Promise.resolve({ moved: 3, already_tagged: 0, into: TAGS[0] })
    return Promise.resolve({ count: TAGS.length, results: TAGS, next: null })
  })
})
afterEach(cleanup)

function mount(url: string) {
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: "/tags",
    component: Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return router
}

describe("the Tags page", () => {
  it("says how many names collide and filters to the pairs", async () => {
    const router = mount("/tags")
    await screen.findByText("1 tag name is used twice")
    expect(screen.getByText("core")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show" }))
    await waitFor(() =>
      expect(
        (router.state.location.search as Record<string, unknown>).names
      ).toBeTruthy()
    )
    await waitFor(() => expect(screen.queryByText("core")).toBeNull())
    expect(screen.getByText("prod")).toBeTruthy()
    expect(screen.getByText("Prod")).toBeTruthy()
  })

  it("marks the global tag", async () => {
    mount("/tags")
    await screen.findByText("core")
    expect(screen.getAllByText("global")).toHaveLength(1)
    expect(screen.getByText("All tenants")).toBeTruthy()
  })

  it("merges a tag after showing how many objects move", async () => {
    mount("/tags")
    await screen.findByText("core")
    const merges = screen.getAllByRole("button", { name: "Merge into…" })
    fireEvent.click(merges[1]) // the tenant "Prod"
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("3 objects tagged.")).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("combobox"))
    // Same-scope-or-global targets: not the site-local tag of another site.
    expect(screen.queryByRole("option", { name: /lab/ })).toBeNull()
    fireEvent.click(await screen.findByRole("option", { name: /prod/ }))
    expect(
      within(dialog).getByText("3 objects move to prod. Prod is deleted.")
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/tags/2/merge/",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ into: 1 }),
        })
      )
    )
  })
})
