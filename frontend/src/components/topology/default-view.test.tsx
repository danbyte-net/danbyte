// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useSearch,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { ApiError } from "@/lib/api"
import { useDefaultView, useSetDefaultView } from "./default-view"

// A real (in-memory) router: the default is applied by replacing the
// address, and the cases under test are what Back does and which addresses
// are left alone.

const { apiMock, successMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  successMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: successMock } }))

const D = "0d0d0d0d-0000-4000-8000-00000000000d"
const E = "0e0e0e0e-0000-4000-8000-00000000000e"

let enabled = true

function MapPage() {
  const search: Record<string, unknown> = useSearch({ strict: false })
  const dv = useDefaultView(search, enabled)
  const set = useSetDefaultView((id) => (id === E ? "edge" : undefined))
  return (
    <div>
      <p data-testid="resolving">{String(dv.resolving)}</p>
      <p data-testid="none">{String(dv.noView)}</p>
      <p data-testid="default">{String(dv.defaultId)}</p>
      <button onClick={() => set.mutate(E)}>set</button>
      <button onClick={() => set.mutate(null)}>clear</button>
    </div>
  )
}

async function mount(url: string) {
  const root = createRootRoute()
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <p data-testid="home">home</p>,
  })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: MapPage,
  })
  const router = createRouter({
    routeTree: root.addChildren([home, page]),
    history: createMemoryHistory({
      initialEntries: ["/", url],
      initialIndex: 1,
    }),
  })
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  await screen.findByTestId("resolving")
  return router
}

const text = (id: string) => screen.getByTestId(id).textContent
const answer = (id: string | null) => apiMock.mockResolvedValue({ id })

beforeEach(() => {
  enabled = true
  apiMock.mockReset()
  successMock.mockReset()
})
afterEach(cleanup)

describe("useDefaultView", () => {
  it("replaces a bare address with the default, so Back leaves", async () => {
    answer(D)
    const router = await mount("/topology")
    const entries = router.history.length
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: D })
    )
    expect(router.history.length).toBe(entries)
    expect(text("resolving")).toBe("false")
    expect(text("none")).toBe("none")
    act(() => router.history.back())
    await screen.findByTestId("home")
  })

  it("is resolving while the default is asked for", async () => {
    let reply: (v: unknown) => void = () => {}
    apiMock.mockReturnValue(new Promise((r) => (reply = r)))
    const router = await mount("/topology")
    expect(text("resolving")).toBe("true")
    expect(text("none")).toBe("none")
    await act(async () => reply({ id: null }))
    await waitFor(() => expect(text("resolving")).toBe("false"))
    // No default: the bare address is No view, and stays.
    expect(router.state.location.search).toEqual({})
    expect(text("none")).toBe("undefined")
  })

  it("adds view=none to any other address, in place", async () => {
    answer(D)
    const router = await mount("/topology?site=s1")
    const entries = router.history.length
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        site: "s1",
        view: "none",
      })
    )
    expect(router.history.length).toBe(entries)
    expect(text("resolving")).toBe("false")
  })

  it("leaves an address that names a view", async () => {
    answer(D)
    for (const url of [`/topology?view=${E}`, "/topology?view=none"]) {
      const router = await mount(url)
      await waitFor(() => expect(text("default")).toBe(D))
      expect(router.state.location.search).toEqual({
        view: url.split("=")[1],
      })
      cleanup()
    }
  })

  it("opens the default again when the address comes back bare", async () => {
    answer(D)
    const router = await mount("/topology")
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: D })
    )
    const entries = router.history.length
    // The sidebar's Topology link, while on the map.
    act(() => void router.navigate({ to: "/topology", search: {} }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: D })
    )
    expect(router.history.length).toBe(entries + 1)
  })

  it("settles again when a later commit puts the bare address back", async () => {
    // The page's first load: the router's own commit of the address it
    // opened on can land after the redirect, and drop it.
    let reply: (v: unknown) => void = () => {}
    apiMock.mockReturnValue(new Promise((r) => (reply = r)))
    const router = await mount("/topology")
    const navigate = router.navigate.bind(router)
    let dropped = 0
    router.navigate = ((opts: Parameters<typeof navigate>[0]) => {
      if (dropped++ === 0) return Promise.resolve()
      return navigate(opts)
    }) as typeof router.navigate
    await act(async () => reply({ id: D }))
    await waitFor(() => expect(dropped).toBe(1))
    expect(router.state.location.search).toEqual({})
    expect(text("resolving")).toBe("true")
    act(() => router.history.replace("/topology"))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: D })
    )
  })

  it("reads a refused default as No view", async () => {
    apiMock.mockRejectedValue(new ApiError(403, {}))
    const router = await mount("/topology")
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    await waitFor(() => expect(text("resolving")).toBe("false"))
    expect(text("none")).toBe("undefined")
    expect(router.state.location.search).toEqual({})
  })

  it("asks nothing of a user who can't read views", async () => {
    enabled = false
    const router = await mount("/topology")
    expect(text("resolving")).toBe("false")
    expect(text("none")).toBe("undefined")
    expect(apiMock).not.toHaveBeenCalled()
    expect(router.state.location.search).toEqual({})
  })
})

describe("useSetDefaultView", () => {
  it("writes the id and shows the new default at once", async () => {
    answer(null)
    await mount("/topology?view=none")
    await waitFor(() => expect(text("default")).toBe("null"))
    apiMock.mockResolvedValueOnce({ id: E })
    fireEvent.click(screen.getByRole("button", { name: "set" }))
    await waitFor(() => expect(text("default")).toBe(E))
    expect(apiMock).toHaveBeenLastCalledWith("/api/topology-views/default/", {
      method: "PUT",
      body: JSON.stringify({ id: E }),
    })
    expect(successMock).toHaveBeenLastCalledWith("Default: “edge”")
    apiMock.mockResolvedValueOnce({ id: null })
    fireEvent.click(screen.getByRole("button", { name: "clear" }))
    await waitFor(() => expect(text("default")).toBe("null"))
    expect(successMock).toHaveBeenLastCalledWith("Default cleared")
  })
})
