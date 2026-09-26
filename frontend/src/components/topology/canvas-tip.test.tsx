// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { CanvasTip } from "./canvas-tip"
import type { CanvasTipHandle } from "./canvas-tip"

// The canvas has one shared tooltip: card elements name themselves with
// data-tip and are picked up by delegation; edges drive it imperatively.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(cleanup)

let api: CanvasTipHandle | null = null

function Canvas() {
  const root = useRef<HTMLDivElement>(null)
  return (
    <div ref={root}>
      <span data-tip="Leaf">spine</span>
      <span data-tip="Ethernet1/49">port</span>
      <span>plain</span>
      <CanvasTip
        root={root}
        ref={(h) => {
          api = h
        }}
      />
    </div>
  )
}

const tip = () =>
  document.querySelector<HTMLElement>("[data-slot=tooltip-content]")

describe("CanvasTip", () => {
  it("shows a data-tip element's text on hover and hides on leave", () => {
    render(<Canvas />)
    expect(tip()).toBeNull()
    fireEvent.pointerOver(screen.getByText("spine"))
    expect(tip()?.textContent).toContain("Leaf")
    fireEvent.pointerOut(screen.getByText("spine"), {
      relatedTarget: screen.getByText("plain"),
    })
    expect(tip()).toBeNull()
  })

  it("hands over between two tip elements", () => {
    render(<Canvas />)
    fireEvent.pointerOver(screen.getByText("spine"))
    fireEvent.pointerOut(screen.getByText("spine"), {
      relatedTarget: screen.getByText("port"),
    })
    fireEvent.pointerOver(screen.getByText("port"))
    expect(tip()?.textContent).toContain("Ethernet1/49")
  })

  it("gets out of the way on pointer down", () => {
    render(<Canvas />)
    fireEvent.pointerOver(screen.getByText("spine"))
    fireEvent.pointerDown(screen.getByText("spine"))
    expect(tip()).toBeNull()
  })

  it("is driven imperatively for edges", () => {
    render(<Canvas />)
    act(() => api?.show("Cable #4 · smf · 40G", { clientX: 10, clientY: 20 }))
    expect(tip()?.textContent).toContain("Cable #4 · smf · 40G")
    act(() => api?.hide())
    expect(tip()).toBeNull()
  })

  it("keeps a port's tip when the pointer leaves a cable onto it", () => {
    render(<Canvas />)
    act(() => api?.show("Cable #4", { clientX: 10, clientY: 20 }))
    // pointerout/over reach the port before the edge's mouseleave.
    fireEvent.pointerOver(screen.getByText("port"))
    act(() => api?.hide())
    expect(tip()?.textContent).toContain("Ethernet1/49")
    fireEvent.pointerOut(screen.getByText("port"), {
      relatedTarget: screen.getByText("plain"),
    })
    expect(tip()).toBeNull()
  })

  it("uses no native title tooltip", () => {
    const { container } = render(<Canvas />)
    fireEvent.pointerOver(screen.getByText("spine"))
    expect(container.querySelector("[title]")).toBeNull()
  })
})
