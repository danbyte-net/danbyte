// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { barFit, useBarFit } from "./bar-fit"
import type { BarFit, BarNeeds } from "./bar-fit"

// What of the second bar gives way to More as it narrows - Copy link, then
// Objects, then Undo and Redo - decided from the bar as drawn, so an
// applied view without edits keeps the controls it has room for.

const NEEDS: BarNeeds = {
  full: 1000,
  copyLink: 106,
  objects: 130,
  history: 72,
  more: 36,
}

describe("barFit", () => {
  it("keeps everything on the bar until it is measured", () => {
    const all = { copyLink: false, objects: false, history: false }
    expect(barFit(null, NEEDS)).toEqual(all)
    expect(barFit(800, null)).toEqual(all)
  })

  it("gives way one control at a time as the bar narrows", () => {
    const at = (w: number) => barFit(w, NEEDS)
    expect(at(1000)).toEqual({
      copyLink: false,
      objects: false,
      history: false,
    })
    // Copy link out, More in: 1000 - 106 + 36.
    expect(at(930)).toEqual({ copyLink: true, objects: false, history: false })
    expect(at(929)).toEqual({ copyLink: true, objects: true, history: false })
    expect(at(800)).toEqual({ copyLink: true, objects: true, history: false })
    expect(at(799)).toEqual({ copyLink: true, objects: true, history: true })
  })
})

// A stand-in bar: each control an element whose width is its `data-w`,
// laid out as the page lays out the second bar (gap-2, the right group
// with Objects, Undo and Redo, Add, Arrange, Copy link, Export and More).
const W = {
  devices: 80,
  picker: 176,
  narrowPicker: 144,
  edited: 52,
  save: 60,
  saveAs: 70,
  remove: 28,
  objects: 90,
  history: 64,
  add: 60,
  arrange: 80,
  copyLink: 98,
  exportMenu: 90,
  more: 28,
}

let seenFit: BarFit | null = null

function Bar({ width, edited }: { width: number; edited: boolean }) {
  const [ref, fit] = useBarFit()
  seenFit = fit
  const right = [
    !fit.objects && W.objects,
    !fit.history && W.history,
    W.add,
    W.arrange,
    !fit.copyLink && W.copyLink,
    W.exportMenu,
    fit.copyLink && W.more,
  ].filter((w): w is number => typeof w === "number")
  const rightW = right.reduce((a, b) => a + b, 0) + 8 * (right.length - 1)
  return (
    <div ref={ref} data-client={width} style={{ columnGap: "8px" }}>
      <span data-w={W.devices} />
      <span data-w={fit.objects ? W.narrowPicker : W.picker} />
      {edited && <span data-w={W.edited} />}
      <span data-w={W.save} />
      <span data-w={W.saveAs} />
      <span data-w={W.remove} />
      <div data-w={rightW}>
        {!fit.objects && <span data-w={W.objects} data-bar-item="objects" />}
        {!fit.history && <span data-w={W.history} data-bar-item="history" />}
        {!fit.copyLink && (
          <span data-w={W.copyLink} data-bar-item="copy-link" />
        )}
        {fit.copyLink && <span data-w={W.more} data-bar-item="more" />}
      </div>
      <span data-testid="fit" hidden>
        {JSON.stringify(fit)}
      </span>
    </div>
  )
}

const proto = HTMLElement.prototype
const saved = {
  offsetWidth: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
  clientWidth: Object.getOwnPropertyDescriptor(
    Element.prototype,
    "clientWidth"
  ),
  rects: proto.getClientRects,
}

beforeAll(() => {
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.w ?? 0)
    },
  })
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.client ?? 0)
    },
  })
  // The hidden readout is off the bar, as display: none would be.
  proto.getClientRects = function (this: HTMLElement) {
    return (this.hidden ? [] : [{}]) as unknown as DOMRectList
  }
})

afterAll(() => {
  if (saved.offsetWidth)
    Object.defineProperty(proto, "offsetWidth", saved.offsetWidth)
  if (saved.clientWidth)
    Object.defineProperty(Element.prototype, "clientWidth", saved.clientWidth)
  proto.getClientRects = saved.rects
})

afterEach(() => {
  cleanup()
  seenFit = null
})

/** The bar's content with everything on it: the left controls, the right
 * group and the gaps between them. */
const full = (edited: boolean) => {
  const left = [
    W.devices,
    W.picker,
    ...(edited ? [W.edited] : []),
    W.save,
    W.saveAs,
    W.remove,
  ]
  const right = [
    W.objects,
    W.history,
    W.add,
    W.arrange,
    W.copyLink,
    W.exportMenu,
  ]
  const sum = (l: number[]) => l.reduce((a, b) => a + b, 0)
  return (
    sum(left) + sum(right) + 8 * (right.length - 1) + 8 * left.length // group
  )
}

describe("useBarFit", () => {
  it("keeps every control of an applied view without edits that fits", () => {
    const width = full(false)
    render(<Bar width={width} edited={false} />)
    expect(seenFit).toEqual({
      copyLink: false,
      objects: false,
      history: false,
    })
    // The same width with Edited showing sends Copy link into More.
    cleanup()
    render(<Bar width={width} edited />)
    expect(seenFit).toEqual({
      copyLink: true,
      objects: false,
      history: false,
    })
  })

  it("brings a control back once the view's edits are saved", () => {
    const width = full(false)
    const { rerender } = render(<Bar width={width} edited />)
    expect(seenFit?.copyLink).toBe(true)
    rerender(<Bar width={width} edited={false} />)
    expect(seenFit?.copyLink).toBe(false)
    expect(screen.getByTestId("fit").textContent).toContain('"copyLink":false')
  })

  it("moves Objects, then Undo and Redo, as the bar narrows", () => {
    const f = full(true)
    // Copy link out, More in; then Objects and the picker's 32px.
    const noCopy = f - (W.copyLink + 8) + (W.more + 8)
    const noObjects = noCopy - (W.objects + 8 + 32)
    render(<Bar width={noCopy - 1} edited />)
    expect(seenFit).toEqual({ copyLink: true, objects: true, history: false })
    cleanup()
    render(<Bar width={noObjects} edited />)
    expect(seenFit).toEqual({ copyLink: true, objects: true, history: false })
    cleanup()
    render(<Bar width={noObjects - 1} edited />)
    expect(seenFit).toEqual({ copyLink: true, objects: true, history: true })
  })
})
