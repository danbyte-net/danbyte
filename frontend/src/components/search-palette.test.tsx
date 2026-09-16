// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it } from "vitest"

import { SearchPalette } from "./search-palette"

function Root() {
  const qc = new QueryClient()
  return (
    <QueryClientProvider client={qc}>
      <SearchPalette />
    </QueryClientProvider>
  )
}

async function mount() {
  const root = createRootRoute({ component: Root })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router as never} />)
  await screen.findByRole("button", { name: "Search" })
}

// cmdk measures its list with ResizeObserver, which jsdom lacks.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO

afterEach(cleanup)

describe("SearchPalette", () => {
  it("opens the dialog on click and on ctrl-k", async () => {
    await mount()
    fireEvent.click(screen.getByRole("button", { name: "Search" }))
    expect(
      await screen.findByPlaceholderText(/Search - or narrow/)
    ).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    fireEvent.keyDown(document, { key: "k", ctrlKey: true })
    expect(
      await screen.findByPlaceholderText(/Search - or narrow/)
    ).toBeTruthy()
  })
})
