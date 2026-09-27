// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LazyRows } from "./lazy-rows"

const ROW = 26
const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${i}`)

function Panel({ items }: { items: string[] }) {
  const [root, setRoot] = useState<HTMLElement | null>(null)
  return (
    <div ref={setRoot} data-root>
      <LazyRows
        root={root}
        rows={items}
        estimate={ROW}
        row={(r) => (
          <div key={r} data-row>
            {r}
          </div>
        )}
      />
    </div>
  )
}

/** The panel shows 0-400px; block i sits at i * 50 rows down. */
function layOut() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-root")) return new DOMRect(0, 0, 300, 400)
      const i = [...(this.parentElement?.children ?? [])].indexOf(this)
      return new DOMRect(0, i * 50 * ROW, 300, 50 * ROW)
    }
  )
}

/** An observer the test answers for: which blocks are near the view. */
function observers() {
  const seen = new Map<Element, (near: boolean) => void>()
  class Stub {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      seen.set(el, (near) =>
        this.cb(
          [{ isIntersecting: near, target: el } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        )
      )
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Stub)
  return seen
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const drawn = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-row]")].map((r) => r.textContent)
const blocks = (c: HTMLElement) =>
  [...c.querySelector("[data-root]")!.children] as HTMLElement[]

describe("LazyRows", () => {
  it("draws a short list plainly", () => {
    observers()
    layOut()
    const { container } = render(<Panel items={rows(50)} />)
    expect(drawn(container)).toEqual(rows(50))
    expect(blocks(container).every((b) => b.hasAttribute("data-row"))).toBe(
      true
    )
  })

  it("draws every row where nothing can watch them", () => {
    const { container } = render(<Panel items={rows(180)} />)
    expect(drawn(container)).toEqual(rows(180))
  })

  it("draws only the blocks near the panel's view", () => {
    observers()
    layOut()
    const { container } = render(<Panel items={rows(180)} />)
    expect(drawn(container)).toEqual(rows(50))
    // The rest hold their place: 50, 50 and 30 rows high.
    expect(blocks(container).map((b) => b.style.height)).toEqual([
      "",
      `${50 * ROW}px`,
      `${50 * ROW}px`,
      `${30 * ROW}px`,
    ])
  })

  it("draws a block as it comes near, and keeps the height it had", () => {
    const seen = observers()
    layOut()
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1234)
    const { container } = render(<Panel items={rows(180)} />)
    const [first, , third] = blocks(container)
    act(() => {
      seen.get(third)!(true)
      seen.get(first)!(false)
    })
    expect(drawn(container)).toEqual(rows(150).slice(100))
    expect(first.style.height).toBe("1234px")
  })
})
