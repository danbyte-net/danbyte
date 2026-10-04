// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ZONE_DRAG_HANDLE, ZoneNode } from "./zone-node"
import type { ZoneData } from "./zone-node"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
afterEach(cleanup)

function zone(data: Partial<ZoneData> = {}, selected = false) {
  return {
    id: "zone:z1",
    data: { label: "Closet", color: "#0ea5e9", ...data },
    selected,
  } as unknown as NodeProps
}

const inFlow = (props: NodeProps) => (
  <ReactFlowProvider>
    <ZoneNode {...props} />
  </ReactFlowProvider>
)

describe("ZoneNode", () => {
  it("renames on double-click, Enter to keep, up to 80 characters", () => {
    const onRename = vi.fn()
    const { container } = render(inFlow(zone({ onRename })))
    fireEvent.doubleClick(
      container.querySelector(`.${ZONE_DRAG_HANDLE} span`) as HTMLElement
    )
    const input = screen.getByDisplayValue("Closet")
    expect(input.getAttribute("maxlength")).toBe("80")
    fireEvent.change(input, { target: { value: "Comms closet" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("Comms closet")
  })

  it("opens its label's editor when its menu asks (renameAt)", () => {
    const { rerender } = render(inFlow(zone()))
    expect(screen.queryByDisplayValue("Closet")).toBeNull()
    rerender(inFlow(zone({ renameAt: 1 })))
    expect(screen.getByDisplayValue("Closet")).toBeTruthy()
  })

  it("has no how-to tip on its grip", () => {
    const { container } = render(inFlow(zone()))
    const grip = container.querySelector(`.${ZONE_DRAG_HANDLE}`)
    expect(grip?.getAttribute("data-tip")).toBe("Move")
    expect(container.querySelector("[title]")).toBeNull()
  })
})
