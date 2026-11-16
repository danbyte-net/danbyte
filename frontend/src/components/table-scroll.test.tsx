// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { HScroll, ScrollFrame } from "./table-scroll"
import { Table, TableBody, TableCell, TableRow } from "./ui/table"

// Wide content outside DataTable gets the same floating scrollbar: shown only
// while the content overflows, and kept in step with the content both ways.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

// One sync per animation frame: frames queue here until the test flushes.
let frames: FrameRequestCallback[] = []
const flush = () => {
  const due = frames
  frames = []
  for (const cb of due) cb(0)
}
beforeEach(() => {
  frames = []
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function size(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(
    scrollWidth
  )
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    clientWidth
  )
}

const proxyOf = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-slot=table-scroll-proxy]")
const viewportOf = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-slot=hscroll-viewport]")!

describe("HScroll", () => {
  it("shows the proxy bar only while the content overflows", () => {
    size(1800, 600)
    const { container } = render(
      <HScroll label="Racks">
        <div>wide</div>
      </HScroll>
    )
    const proxy = proxyOf(container)
    expect(proxy).not.toBeNull()
    expect((proxy!.firstElementChild as HTMLElement).style.width).toBe("1800px")
    const viewport = viewportOf(container)
    // Its own bar hides behind the proxy; it becomes a named tab stop.
    expect(viewport.hasAttribute("data-scroll-proxy")).toBe(true)
    expect(viewport.getAttribute("tabindex")).toBe("0")
    expect(viewport.getAttribute("aria-label")).toBe("Racks")
    expect(viewport.parentElement!.hasAttribute("data-scroll-right")).toBe(true)
  })

  it("renders no proxy and no tab stop when the content fits", () => {
    size(600, 600)
    const { container } = render(
      <HScroll label="Racks">
        <div>narrow</div>
      </HScroll>
    )
    expect(proxyOf(container)).toBeNull()
    const viewport = viewportOf(container)
    expect(viewport.hasAttribute("data-scroll-proxy")).toBe(false)
    expect(viewport.hasAttribute("tabindex")).toBe(false)
  })

  it("syncs scrollLeft from the content to the bar and back", () => {
    size(1800, 600)
    const { container } = render(
      <HScroll>
        <div>wide</div>
      </HScroll>
    )
    const viewport = viewportOf(container)
    const proxy = proxyOf(container)!

    viewport.scrollLeft = 240
    fireEvent.scroll(viewport)
    flush()
    expect(proxy.scrollLeft).toBe(240)

    proxy.scrollLeft = 510
    fireEvent.scroll(proxy)
    flush()
    expect(viewport.scrollLeft).toBe(510)
  })

  it("hands its ref the scrolling viewport", () => {
    size(600, 600)
    let el: HTMLDivElement | null = null
    render(
      <HScroll viewportRef={(n) => void (el = n)}>
        <div>x</div>
      </HScroll>
    )
    expect(el).not.toBeNull()
    expect((el as unknown as HTMLElement).dataset.slot).toBe("hscroll-viewport")
  })
})

describe("ScrollFrame", () => {
  it("floats the bar for a plain Table that overflows", () => {
    size(1400, 500)
    const { container } = render(
      <ScrollFrame className="rounded-lg border">
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>a</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </ScrollFrame>
    )
    expect(proxyOf(container)).not.toBeNull()
    const scroller = container.querySelector("[data-slot=table-container]")
    expect(scroller?.hasAttribute("data-scroll-proxy")).toBe(true)
  })
})
