import { useCallback, useRef, useState } from "react"

// Which of the second bar's controls give way to its More (⋯) menu as the
// bar narrows: Copy link first, then Objects, then Undo and Redo. Decided
// from the bar's measured width rather than CSS container queries, so the
// More menu - which opens in a portal, outside the bar - can list exactly
// what left the bar and nothing that is still on it.

/** The content width (px) the bar needs with every control on it, by
 * whether a view is applied (its Edited, Save and Delete). The Diagram and
 * the Hierarchy show the same controls. Measured at the widest, with a few
 * px to spare. */
const NEEDS = { none: 956, view: 1128 } as const

/** What each control frees when it moves into More: its width and the gap
 * after it. More itself costs its button. */
const COPY_LINK = 106
const OBJECTS = 98
const MORE = 36

/** In More (true) or on the bar. */
export interface BarFit {
  copyLink: boolean
  objects: boolean
  history: boolean
}

const ALL_ON_BAR: BarFit = { copyLink: false, objects: false, history: false }

/** What gives way at `width` (null: not measured yet - everything stays,
 * as the server renders it). Past the last step the bar scrolls. */
export function barFit(width: number | null, view: boolean): BarFit {
  const all = NEEDS[view ? "view" : "none"]
  if (width === null || width >= all) return ALL_ON_BAR
  const noCopy = all - COPY_LINK + MORE
  if (width >= noCopy) return { ...ALL_ON_BAR, copyLink: true }
  if (width >= noCopy - OBJECTS)
    return { ...ALL_ON_BAR, copyLink: true, objects: true }
  return { copyLink: true, objects: true, history: true }
}

/** An element's content width (inside its padding), kept current: a ref
 * callback for the element and the width, null until it has one. Measured
 * when it mounts too, so the first paint already fits. */
export function useContentWidth(): [
  (el: HTMLElement | null) => void,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      setWidth(
        el.clientWidth -
          parseFloat(cs.paddingLeft || "0") -
          parseFloat(cs.paddingRight || "0")
      )
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    observer.current = new ResizeObserver(measure)
    observer.current.observe(el)
  }, [])
  return [ref, width]
}
