// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
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

import type { Application } from "@/lib/api"
import { EmbeddedAppMap } from "@/components/application-map/embedded"

import { Route } from "./application-map"

// Maps → Application map (#163): its chrome, both views, the empty states
// that say how things get onto it, a card's panel, and the application's
// Diagram tab embedding the same map.

const { apiMock, canvasProps } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  canvasProps: [] as Record<string, unknown>[],
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: { active_tenant: { name: "Acme" } } }),
}))
// React Flow has nothing to measure in jsdom: what matters is what the
// canvas is asked to draw.
vi.mock("@/components/application-map/app-map-canvas", () => ({
  AppMapCanvas: (props: Record<string, unknown>) => {
    canvasProps.push(props)
    return <div data-testid="canvas" />
  },
}))

window.scrollTo = () => undefined
afterEach(cleanup)

beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})

const page = <T,>(results: T[]) => ({
  count: results.length,
  next: null,
  results,
})

function application(
  id: string,
  name: string,
  over: Partial<Application> = {}
): Application {
  return {
    id,
    numid: 1,
    name,
    slug: id,
    path: name,
    depth: 0,
    parent: null,
    manufacturer: null,
    eol_source: "",
    eol_product: "",
    eol: null,
    description: "",
    tags: [],
    custom_fields: {},
    install_count: 0,
    child_count: 0,
    flow_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  }
}

let answers: Record<string, unknown> = {}
beforeEach(() => {
  canvasProps.length = 0
  answers = {
    "/api/applications/": page([]),
    "/api/installed-software/": page([]),
    "/api/application-flows/": page([]),
    "/api/statuses/": page([]),
  }
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    const key = Object.keys(answers).find((k) => path.startsWith(k))
    return key ? Promise.resolve(answers[key]) : new Promise(() => undefined)
  })
})

function mount(url = "/application-map") {
  const Page = Route.options.component!
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/application-map",
    component: Page,
    validateSearch: Route.options.validateSearch,
  })
  const router = createRouter({
    routeTree: root.addChildren([map]),
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

const lastCanvas = () => canvasProps[canvasProps.length - 1]

describe("Application map page", () => {
  it("opens on the Tree and says how applications get onto it", async () => {
    mount()
    expect(
      await screen.findByRole("heading", { name: "Application map" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Tree" }).getAttribute("aria-current")
    ).toBe("page")
    expect(screen.getByRole("button", { name: "Flows" })).toBeTruthy()
    expect(await screen.findByText("No applications yet.")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "Applications" }).getAttribute("href")
    ).toBe("/applications")
    expect(
      screen.getByRole("button", { name: /Export/ }).hasAttribute("disabled")
    ).toBe(true)
  })

  it("draws the tree with its hosts, and opens a card's panel", async () => {
    const pay = application("pay", "Payments", { child_count: 1 })
    const api = application("api", "checkout-api", {
      parent: { id: "pay", name: "Payments" },
      path: "Payments › checkout-api",
      install_count: 1,
    })
    answers["/api/applications/"] = page([pay, api])
    answers["/api/installed-software/"] = page([
      {
        id: "i1",
        application: { id: "api", name: "checkout-api", slug: "api", path: "" },
        device: { id: "d1", name: "web1" },
        virtual_machine: null,
        version: "2.1",
      },
    ])
    mount()
    await screen.findByTestId("canvas")
    const graph = lastCanvas().graph as {
      nodes: { id: string }[]
      bands: { label: string }[]
    }
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      ["app:api", "app:pay", "host:device:d1"].sort()
    )
    expect(graph.bands.map((b) => b.label)).toEqual([
      "Level 1",
      "Level 2",
      "Hosts",
    ])
    expect(screen.getByText("Parent to child")).toBeTruthy()
    const select = lastCanvas().onSelectNode as (n: unknown) => void
    act(() =>
      select((graph.nodes as { id: string }[]).find((n) => n.id === "app:api"))
    )
    expect(
      screen.getByRole("complementary", { name: "Application" })
    ).toBeTruthy()
    expect(
      screen
        .getByRole("link", { name: /Open application/ })
        .getAttribute("href")
    ).toBe("/applications/api")
  })

  it("draws the flows from the URL's view and filters", async () => {
    mount("/application-map?view=flows&status=s1&apps=a1")
    expect(await screen.findByText("Nothing on the map matches.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/api\/application-flows\/\?application=a1&status=s1&page_size=/
      )
    )
  })
})

describe("An application's Diagram tab", () => {
  it("embeds the map filtered to the application, with a way to the full map", async () => {
    const app = application("a1", "Shop")
    const root = createRootRoute({
      component: () => <EmbeddedAppMap app={app} />,
    })
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    )
    const open = await screen.findByRole("link", {
      name: /Open in Application map/,
    })
    expect(open.getAttribute("href")).toBe(
      "/application-map?view=flows&apps=a1"
    )
    expect(await screen.findByText("No flows yet.")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/application-flows\/\?application=a1&/)
    )
  })
})
