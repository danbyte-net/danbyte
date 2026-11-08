// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"

import { TOOLS, ToolRail, toolForKey } from "./tool-rail"
import { EDIT_MODE_KEY, useEditMode } from "./use-edit-mode"
import { TOOL_MODE } from "./use-plan-edit-state"

// The editor's tool rail and its View / Edit switch: View by default,
// remembered per browser, and never Edit for someone who may not change the
// plan.

afterEach(cleanup)

function rail(props: Partial<Parameters<typeof ToolRail>[0]> = {}) {
  const onToolChange = vi.fn()
  const onToggleFree = vi.fn()
  render(
    <TooltipProvider>
      <ToolRail
        tool="select"
        onToolChange={onToolChange}
        free={false}
        onToggleFree={onToggleFree}
        {...props}
      />
    </TooltipProvider>
  )
  return { onToolChange, onToggleFree }
}

describe("the tool rail", () => {
  it("lists the tools and marks the one in hand", () => {
    rail({ tool: "rect" })
    for (const t of TOOLS)
      expect(screen.getByRole("button", { name: t.label })).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Room or area" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    expect(
      screen
        .getByRole("button", { name: "Select" })
        .getAttribute("aria-pressed")
    ).toBe("false")
  })

  it("picks a tool on a click", () => {
    const { onToolChange } = rail()
    fireEvent.click(screen.getByRole("button", { name: "Label" }))
    expect(onToolChange).toHaveBeenCalledWith("label")
    fireEvent.click(screen.getByRole("button", { name: "Polygon area" }))
    expect(onToolChange).toHaveBeenCalledWith("polygon")
  })

  it("switches the plan to free placement, and offers the way back", () => {
    const { onToggleFree } = rail()
    fireEvent.click(screen.getByRole("button", { name: "Free placement" }))
    expect(onToggleFree).toHaveBeenCalled()
    cleanup()
    rail({ free: true })
    expect(
      screen
        .getByRole("button", { name: "Back to the grid…" })
        .getAttribute("aria-pressed")
    ).toBe("true")
  })

  it("answers its keys", () => {
    expect(toolForKey("v", false)).toBe("select")
    expect(toolForKey("R", false)).toBe("rect")
    expect(toolForKey("R", true)).toBe("polygon")
    expect(toolForKey("t", false)).toBe("label")
    expect(toolForKey("g", false)).toBe("tiles")
    expect(toolForKey("w", false)).toBe("structure")
    expect(toolForKey("c", false)).toBe("trays")
    expect(toolForKey("x", false)).toBeNull()
  })

  it("draws areas and labels on the layout, walls and trays on their own", () => {
    expect(TOOL_MODE.rect).toBe("layout")
    expect(TOOL_MODE.label).toBe("layout")
    expect(TOOL_MODE.structure).toBe("structure")
    expect(TOOL_MODE.trays).toBe("cable")
  })
})

describe("View and Edit", () => {
  beforeEach(() => window.localStorage.clear())

  it("opens in View", () => {
    const { result } = renderHook(() => useEditMode(true))
    expect(result.current.editing).toBe(false)
  })

  it("remembers Edit in this browser", () => {
    const { result } = renderHook(() => useEditMode(true))
    act(() => result.current.setEdit(true))
    expect(result.current.editing).toBe(true)
    expect(window.localStorage.getItem(EDIT_MODE_KEY)).toBe("1")
    const again = renderHook(() => useEditMode(true))
    expect(again.result.current.editing).toBe(true)
  })

  it("is never Edit without the change permission", () => {
    window.localStorage.setItem(EDIT_MODE_KEY, "1")
    const { result } = renderHook(() => useEditMode(false))
    expect(result.current.editing).toBe(false)
    act(() => result.current.setEdit(true))
    expect(result.current.editing).toBe(false)
  })
})
