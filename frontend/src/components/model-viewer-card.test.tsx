// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"

import { ModelViewerCard, OverviewWithAside } from "./model-viewer-card"

// The Overview's "3D model" card: the toolbar drives the viewer (a WebGL
// canvas, stood in for here), and the right column exists only with a model.

vi.mock("@/components/floorplan3d/model-viewer", () => ({
  default: (p: {
    model: { url: string }
    deviceId?: string | null
    markers?: boolean
    view?: { preset: string }
  }) => (
    <div
      data-testid="model-viewer"
      data-url={p.model.url}
      data-device={p.deviceId ?? ""}
      data-markers={String(p.markers)}
      data-view={p.view?.preset}
    />
  ),
}))

afterEach(cleanup)

function mount(node: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/devices/$id",
    component: () => <>{node}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/devices/d1"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const MODEL = {
  url: "/api/devices/d1/model/?v=1",
  fit: "auto" as const,
  up: "y" as const,
  front: "+z" as const,
}

describe("OverviewWithAside", () => {
  it("adds the right column only with something in it", async () => {
    mount(
      <OverviewWithAside aside={null}>
        <p>cards</p>
      </OverviewWithAside>
    )
    await screen.findByText("cards")
    expect(document.querySelector("[data-overview-aside]")).toBeNull()
    cleanup()
    mount(
      <OverviewWithAside aside={<p>viewer</p>}>
        <p>cards</p>
      </OverviewWithAside>
    )
    await screen.findByText("viewer")
    const grid = document.querySelector("[data-overview-aside]")!
    expect(grid.querySelector("aside")!.className).toContain("xl:sticky")
  })
})

describe("ModelViewerCard", () => {
  it("draws the device's model with its port markers and a source", async () => {
    mount(
      <ModelViewerCard
        source={{ model: MODEL, deviceId: "d1" }}
        sourceLabel="From type"
      />
    )
    const viewer = await screen.findByTestId("model-viewer")
    expect(viewer.dataset.url).toBe(MODEL.url)
    expect(viewer.dataset.device).toBe("d1")
    expect(viewer.dataset.markers).toBe("true")
    expect(viewer.dataset.view).toBe("fit")
    expect(screen.getByText("3D model")).toBeTruthy()
    expect(screen.getByText("From type")).toBeTruthy()
  })

  it("turns the camera and the markers from its toolbar", async () => {
    mount(<ModelViewerCard source={{ model: MODEL, deviceId: "d1" }} />)
    const viewer = await screen.findByTestId("model-viewer")
    fireEvent.click(screen.getByRole("button", { name: "Rear" }))
    expect(viewer.dataset.view).toBe("rear")
    fireEvent.click(screen.getByRole("button", { name: "Top" }))
    expect(viewer.dataset.view).toBe("top")
    fireEvent.click(screen.getByRole("button", { name: "Fit" }))
    expect(viewer.dataset.view).toBe("fit")
    fireEvent.click(screen.getByRole("button", { name: "Ports" }))
    expect(viewer.dataset.markers).toBe("false")
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy()
  })

  it("offers no markers toggle for a type with nothing mapped", async () => {
    mount(<ModelViewerCard source={{ model: MODEL, templatePorts: null }} />)
    await screen.findByTestId("model-viewer")
    expect(screen.queryByRole("button", { name: "Ports" })).toBeNull()
  })
})
