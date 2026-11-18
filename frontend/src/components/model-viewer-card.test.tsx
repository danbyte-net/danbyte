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

import { STACK_VIEW_KEY } from "@/lib/stack-view"

import { ModelViewerCard } from "./model-viewer-card"

// The Overview's "3D model" card: the toolbar drives the viewer (a WebGL
// canvas, stood in for here), and the right column exists only with a model.

vi.mock("@/components/floorplan3d/model-viewer", () => ({
  default: (p: {
    model: { url: string }
    deviceId?: string | null
    markers?: boolean
    outlineAll?: boolean
    stackView?: boolean
    view?: { preset: string }
  }) => (
    <div
      data-testid="model-viewer"
      data-url={p.model.url}
      data-device={p.deviceId ?? ""}
      data-markers={String(p.markers)}
      data-outline={String(!!p.outlineAll)}
      data-stack={String(!!p.stackView)}
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
    // Markers always draw (pickable); quiet until Ports outlines them all.
    expect(viewer.dataset.markers).not.toBe("false")
    expect(viewer.dataset.outline).toBe("false")
    // A face, straight on, first.
    expect(viewer.dataset.view).toBe("front")
    expect(screen.getByText("3D model")).toBeTruthy()
    expect(screen.getByText("From type")).toBeTruthy()
  })

  it("turns the camera and the port outlines from its toolbar", async () => {
    mount(<ModelViewerCard source={{ model: MODEL, deviceId: "d1" }} />)
    const viewer = await screen.findByTestId("model-viewer")
    fireEvent.click(screen.getByRole("button", { name: "Rear" }))
    expect(viewer.dataset.view).toBe("rear")
    fireEvent.click(screen.getByRole("button", { name: "Top" }))
    expect(viewer.dataset.view).toBe("top")
    // Fit re-frames the view it is on.
    fireEvent.click(screen.getByRole("button", { name: "Fit" }))
    expect(viewer.dataset.view).toBe("top")
    fireEvent.click(screen.getByRole("button", { name: "3D" }))
    expect(viewer.dataset.view).toBe("iso")
    const ports = screen.getByRole("button", { name: "Ports" })
    fireEvent.click(ports)
    expect(viewer.dataset.outline).toBe("true")
    expect(viewer.dataset.markers).not.toBe("false")
    fireEvent.click(ports)
    expect(viewer.dataset.outline).toBe("false")
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy()
  })

  it("offers Stack on a stack member and remembers it", async () => {
    mount(<ModelViewerCard source={{ model: MODEL, deviceId: "d1" }} />)
    await screen.findByTestId("model-viewer")
    expect(screen.queryByRole("button", { name: "Stack" })).toBeNull()
    cleanup()
    mount(
      <ModelViewerCard
        source={{ model: MODEL, deviceId: "d1", stackId: "vc1" }}
      />
    )
    const viewer = await screen.findByTestId("model-viewer")
    expect(viewer.dataset.stack).toBe("false")
    expect(screen.queryByRole("button", { name: /Stacks/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Stack" }))
    expect(viewer.dataset.stack).toBe("true")
    expect(window.localStorage.getItem(STACK_VIEW_KEY)).toBe("1")
    // The stack cables' Show / Ghost / Hide, while the stack shows.
    expect(screen.getByRole("button", { name: /Stacks/ })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Stack" }))
    expect(viewer.dataset.stack).toBe("false")
  })

  it("offers no Ports toggle for a type with nothing mapped", async () => {
    mount(<ModelViewerCard source={{ model: MODEL, templatePorts: null }} />)
    await screen.findByTestId("model-viewer")
    expect(screen.queryByRole("button", { name: "Ports" })).toBeNull()
  })
})
