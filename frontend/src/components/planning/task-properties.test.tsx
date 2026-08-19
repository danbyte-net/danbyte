// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PlanningStatus } from "@/lib/api"
import { PriorityPicker, PropertyTable, StatusPicker } from "./task-properties"

/**
 * The task's property table makes each cell its own editor, and a cell is a
 * `DropdownMenuTrigger asChild` wrapping a shared trigger component. Radix
 * clones that child to inject the onClick, ref and aria state that make it a
 * trigger - so a wrapper that names only the props it cares about silently
 * swallows them, and the cell renders perfectly while doing nothing at all.
 *
 * That shipped once. Typecheck cannot see it (the swallowed props are extra,
 * not missing) and neither can a screenshot. These open a picker for real.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const STATUSES: PlanningStatus[] = [
  {
    id: "s1",
    board: "b",
    name: "To do",
    semantic_group: "unstarted",
    color: "#3b82f6",
    weight: 10,
  },
  {
    id: "s2",
    board: "b",
    name: "Done",
    semantic_group: "completed",
    color: "#10b981",
    weight: 20,
  },
]

afterEach(cleanup)

describe("task property cells", () => {
  it("opens the status picker and reports the pick", async () => {
    const onChange = vi.fn()
    render(
      <StatusPicker
        statuses={STATUSES}
        value="s1"
        onChange={onChange}
        canEdit
      />
    )

    fireEvent.pointerDown(
      screen.getByRole("button"),
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    )
    const done = await screen.findByText("Done")
    fireEvent.click(done)
    expect(onChange).toHaveBeenCalledWith("s2")
  })

  it("opens the priority picker and reports the pick", async () => {
    const onChange = vi.fn()
    render(<PriorityPicker value="none" onChange={onChange} canEdit />)

    fireEvent.pointerDown(
      screen.getByRole("button"),
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    )
    fireEvent.click(await screen.findByText("Urgent"))
    expect(onChange).toHaveBeenCalledWith("urgent")
  })

  it("opens from inside the property table, which is where it actually lives", async () => {
    const onChange = vi.fn()
    render(
      <PropertyTable
        rows={[
          {
            label: "Status",
            value: (
              <StatusPicker
                statuses={STATUSES}
                value="s1"
                onChange={onChange}
                canEdit
              />
            ),
          },
        ]}
      />
    )
    fireEvent.pointerDown(
      screen.getByRole("button"),
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    )
    fireEvent.click(await screen.findByText("Done"))
    expect(onChange).toHaveBeenCalledWith("s2")
  })

  it("renders a plain value, not a control, without edit rights", () => {
    render(
      <StatusPicker
        statuses={STATUSES}
        value="s1"
        onChange={vi.fn()}
        canEdit={false}
      />
    )
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("To do")).toBeTruthy()
  })
})
