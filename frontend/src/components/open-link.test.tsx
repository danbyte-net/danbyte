// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it } from "vitest"

import { OpenLink } from "./open-link"

afterEach(cleanup)

// A real in-memory router: the point of OpenLink is that it is a router link
// (no full reload), so the test navigates with it rather than inspecting it.
function makeRouter() {
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => (
      <OpenLink to="/devices/$id" params={{ id: "d1" }}>
        Open device
      </OpenLink>
    ),
  })
  const device = createRoute({
    getParentRoute: () => root,
    path: "/devices/$id",
    component: () => <p>device page</p>,
  })
  return createRouter({
    routeTree: root.addChildren([map, device]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
  })
}

describe("OpenLink", () => {
  it("is a bar button link with a leading ArrowUpRight", async () => {
    render(<RouterProvider router={makeRouter() as never} />)
    const a = await screen.findByRole("link", { name: "Open device" })
    expect(a.getAttribute("href")).toBe("/devices/d1")
    expect(a.getAttribute("data-slot")).toBe("button")
    expect(a.className).toContain("h-7")
    expect(a.className).toContain("text-xs")
    expect(a.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-arrow-up-right"
    )
  })

  it("navigates inside the app", async () => {
    const router = makeRouter()
    render(<RouterProvider router={router as never} />)
    fireEvent.click(await screen.findByRole("link", { name: "Open device" }))
    expect(await screen.findByText("device page")).toBeTruthy()
    expect(router.state.location.pathname).toBe("/devices/d1")
  })
})
