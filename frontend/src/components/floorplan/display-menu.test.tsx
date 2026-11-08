// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { UseMutationResult } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { DisplayMenu } from "./display-menu"
import { usePlanViewPrefs } from "./use-plan-view-prefs"

// Display > Photos: a plan view preference, saved with the others for an
// editor, that draws every tile with a photo as it; Photo outlines, off
// until asked for, outlines them.

vi.mock("@/lib/use-me", () => ({ useMe: () => ({}) }))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(cleanup)

const plan = { id: "p1", state: { show_fov: false } } as unknown as FloorPlan

function Harness({ mutate }: { mutate: (v: unknown) => void }) {
  const prefs = usePlanViewPrefs({
    id: "p1",
    plan,
    canEdit: true,
    patchPlan: { mutate } as unknown as UseMutationResult<
      FloorPlan,
      Error,
      Record<string, unknown>
    >,
  })
  return (
    <TooltipProvider>
      <span data-testid="photos">{String(prefs.showPhotos)}</span>
      <DisplayMenu view3d={false} prefs={prefs} />
    </TooltipProvider>
  )
}

describe("Display > Photos", () => {
  it("is off by default and saves on the plan's state", async () => {
    const mutate = vi.fn()
    render(<Harness mutate={mutate} />)
    expect(screen.getByTestId("photos").textContent).toBe("false")
    fireEvent.click(screen.getByRole("button", { name: /Display/ }))
    fireEvent.click(await screen.findByLabelText("Photos"))
    expect(screen.getByTestId("photos").textContent).toBe("true")
    expect(mutate).toHaveBeenCalledWith({
      state: { show_fov: false, show_photos: true },
    })
  })

  it("offers the cables' colour, labels and bundling with the links on", async () => {
    const mutate = vi.fn()
    render(<Harness mutate={mutate} />)
    fireEvent.click(screen.getByRole("button", { name: /Display/ }))
    expect(screen.queryByLabelText("Bundle parallel runs")).toBeNull()
    fireEvent.click(await screen.findByLabelText("Cable links (A↔B)"))
    const bundle = await screen.findByLabelText("Bundle parallel runs")
    // Bundling is on until turned off; labels too.
    expect(
      bundle.getAttribute("aria-checked") ?? bundle.getAttribute("data-state")
    ).toMatch(/true|checked/)
    expect(screen.getByLabelText("Color cables by").textContent).toContain(
      "Status"
    )
    fireEvent.click(bundle)
    expect(mutate).toHaveBeenLastCalledWith({
      state: { show_fov: false, bundle_cables: false },
    })
    fireEvent.click(screen.getByLabelText("Cable labels"))
    expect(mutate).toHaveBeenLastCalledWith({
      state: { show_fov: false, show_cable_labels: false },
    })
  })

  it("Photo outlines is off by default and saved like the rest", async () => {
    const mutate = vi.fn()
    render(<Harness mutate={mutate} />)
    fireEvent.click(screen.getByRole("button", { name: /Display/ }))
    const box = await screen.findByLabelText("Photo outlines")
    expect(
      box.getAttribute("aria-checked") ?? box.getAttribute("data-state")
    ).toMatch(/false|unchecked/)
    fireEvent.click(box)
    expect(mutate).toHaveBeenCalledWith({
      state: { show_fov: false, show_photo_outlines: true },
    })
  })
})
