// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useSearch,
} from "@tanstack/react-router"
import { useRef } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { useUrlPatch } from "@/lib/use-url-state"
import {
  emptyDocument,
  mapKeyOf,
  useMapLeaveGuard,
  useViewDocument,
} from "./view-document"
import type { ViewDocument } from "./view-document"

// A real (in-memory) router: the leave guard is the router's blocker, and
// the case under test is the page's own redirect after a save racing an
// edit - the save's request is in flight while the user drags a card.

const A = "0a0a0a0a-0000-4000-8000-000000000001"
const B = "0b0b0b0b-0000-4000-8000-000000000002"

function MapPage() {
  const search: Record<string, unknown> = useSearch({ strict: false })
  const key = mapKeyOf(search)
  const doc = useViewDocument(() => ({ doc: emptyDocument(), key }))
  const guard = useMapLeaveGuard(doc)
  const patch = useUrlPatch()
  const sent = useRef<ViewDocument | null>(null)
  const edit = (line: "bendy" | "elbow") =>
    doc.dispatch({ type: "setLink", key: `${A}|${B}`, value: { line } })
  /** What the save mutation's onSuccess does once the POST returns. */
  const saved = (ignoreBlocker: boolean) => {
    doc.markSaved(sent.current!, "view:v1", "2026-09-26T00:00:00Z")
    patch({ view: "v1", devices: undefined }, { ignoreBlocker })
  }
  return (
    <div>
      <p data-testid="map">{key}</p>
      <p data-testid="dirty">{String(doc.dirty)}</p>
      <p data-testid="guard">{guard.status}</p>
      <button onClick={() => edit("bendy")}>edit</button>
      <button onClick={() => (sent.current = doc.doc)}>send</button>
      <button onClick={() => edit("elbow")}>edit-in-flight</button>
      <button onClick={() => saved(true)}>saved</button>
      <button onClick={() => saved(false)}>saved-unguarded</button>
      <button onClick={() => patch({ devices: undefined })}>leave</button>
    </div>
  )
}

async function mount(url: string) {
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: MapPage,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  render(<RouterProvider router={router as never} />)
  await screen.findByTestId("map")
  return router
}

const text = (id: string) => screen.getByTestId(id).textContent
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }))

/** A custom map, edited, saved as a view, edited again before the save
 * returns. */
async function saveRacingAnEdit() {
  const router = await mount(`/topology?devices=${A},${B}`)
  expect(text("map")).toBe("custom")
  click("edit")
  click("send")
  click("edit-in-flight")
  expect(text("dirty")).toBe("true")
  return router
}

afterEach(() => {
  cleanup()
})

describe("useMapLeaveGuard", () => {
  it("lets the page's own move onto the saved view through", async () => {
    const router = await saveRacingAnEdit()
    act(() => click("saved"))
    await waitFor(() => expect(text("map")).toBe("view:v1"))
    expect(text("guard")).toBe("idle")
    expect(router.state.location.search).toEqual({ view: "v1" })
    // The edit made while the save was in flight is still unsaved.
    expect(text("dirty")).toBe("true")
  })

  it("would ask to discard without ignoreBlocker (the regression)", async () => {
    await saveRacingAnEdit()
    act(() => click("saved-unguarded"))
    await waitFor(() => expect(text("guard")).toBe("blocked"))
    expect(text("map")).toBe("custom")
  })

  it("still guards a real leave with unsaved edits", async () => {
    await mount(`/topology?devices=${A}`)
    click("edit")
    act(() => click("leave"))
    await waitFor(() => expect(text("guard")).toBe("blocked"))
    expect(text("map")).toBe("custom")
  })
})
