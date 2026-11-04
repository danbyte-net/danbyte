// Shared mounting for the list-page bulk-select tests. Each test file mocks
// `@/lib/api`, `@/lib/api-all`, `@/lib/use-me` and the list shell itself
// (vi.mock is hoisted per file); this mounts a route component in a memory
// router and ticks rows.
import type { ReactNode } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The DOM pieces jsdom lacks and the table and dialogs use. */
export function stubDom() {
  if (!("ResizeObserver" in globalThis)) {
    ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
      ResizeObserverStub
  }
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
}

/** A stand-in for ListPageShell: the rail, the actions and the body. */
export function ShellStub({
  rail,
  actions,
  children,
}: {
  rail?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div>
      {rail}
      {actions}
      {children}
    </div>
  )
}

/** Mount `component` at `path` in a memory router. */
export function mountRoute(path: string, component: unknown) {
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path,
    component: component as never,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

/** Wait for `rowText`, tick every row; the selection bar that floats up. */
export async function tickAll(rowText: string) {
  await screen.findByText(rowText)
  for (const box of screen.getAllByRole("checkbox", { name: "Select row" }))
    fireEvent.click(box)
  const clear = await screen.findByRole("button", { name: "Clear selection" })
  return within(clear.parentElement!)
}

/** The body of the first call to a path ending in `suffix`. */
export function bodyOf(
  calls: [string, RequestInit?][],
  suffix: string
): unknown {
  const call = calls.find(([p]) => p.endsWith(suffix))
  if (!call) throw new Error(`No call to …${suffix}`)
  return JSON.parse(String(call[1]?.body))
}

/** A safe bulk delete's dry-run answer: `kept` skipped with `reason`. */
export function deleteAnswer(
  deleted: string[],
  kept: { id: string; name: string; reason: string }[] = []
) {
  return {
    deleted: deleted.length,
    deleted_ids: deleted,
    skipped: kept,
    impact: [],
    released: [],
    dry_run: true,
  }
}
