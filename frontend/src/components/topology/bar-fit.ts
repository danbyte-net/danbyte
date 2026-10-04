import { useCallback, useLayoutEffect, useRef, useState } from "react"

// Which of the second bar's controls give way to its More (⋯) menu as the
// bar narrows: Copy link first, then Objects, then Undo and Redo. Decided
// from the bar as drawn - its width and what its controls take - rather
// than CSS container queries, so the More menu, which opens in a portal
// outside the bar, can list exactly what left the bar and nothing that is
// still on it. Measured after every render, since what the bar holds
// changes with the view: Edited, Save and Delete come and go, a view's
// name, Saving… for Save.

/** In More (true) or on the bar. */
export interface BarFit {
  copyLink: boolean
  objects: boolean
  history: boolean
}

/** What the bar needs, px: its content with every control on it, what
 * each control frees when it moves into More, and what More costs once
 * something is in it - each with the gap before it. */
export interface BarNeeds {
  full: number
  copyLink: number
  objects: number
  history: number
  more: number
}

const ALL_ON_BAR: BarFit = { copyLink: false, objects: false, history: false }

/** What gives way at `width` (null: not measured yet - everything stays,
 * as the server renders it). Past the last step the bar scrolls. */
export function barFit(width: number | null, needs: BarNeeds | null): BarFit {
  if (width === null || !needs || width >= needs.full) return ALL_ON_BAR
  const noCopy = needs.full - needs.copyLink + needs.more
  if (width >= noCopy) return { ...ALL_ON_BAR, copyLink: true }
  if (width >= noCopy - needs.objects)
    return { ...ALL_ON_BAR, copyLink: true, objects: true }
  return { copyLink: true, objects: true, history: true }
}

/** The controls that move, as the bar marks them (`data-bar-item`). */
type Item = "copy-link" | "objects" | "history" | "more"

/** A control's width before it has been seen on the bar. The bar opens
 * with everything on it, so these stand in only until the first measure. */
const GUESS: Record<Item, number> = {
  "copy-link": 98,
  objects: 90,
  history: 64,
  more: 28,
}

/** The views picker narrows by this much once Objects is in More (w-44 →
 * w-36): room Objects frees as well. */
const PICKER_SHRINK = 32

/** An element's content width (inside its padding). */
function contentWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  return (
    el.clientWidth -
    parseFloat(cs.paddingLeft || "0") -
    parseFloat(cs.paddingRight || "0")
  )
}

/** The bar's needs, from what is on it now (`fit`) and what each control
 * that is in More took when it was last on the bar (`seen`). */
function measureNeeds(
  bar: HTMLElement,
  fit: BarFit,
  seen: Partial<Record<Item, number>>
): BarNeeds {
  const gap = parseFloat(getComputedStyle(bar).columnGap) || 0
  const kids = [...bar.children].filter(
    (k): k is HTMLElement =>
      k instanceof HTMLElement && k.getClientRects().length > 0
  )
  const drawn =
    kids.reduce((w, k) => w + k.offsetWidth, 0) +
    gap * Math.max(0, kids.length - 1)
  for (const item of Object.keys(GUESS) as Item[]) {
    const el = bar.querySelector<HTMLElement>(`[data-bar-item="${item}"]`)
    if (el) seen[item] = el.offsetWidth
  }
  const cost = (item: Item) => (seen[item] ?? GUESS[item]) + gap
  const needs = {
    copyLink: cost("copy-link"),
    objects: cost("objects") + PICKER_SHRINK,
    history: cost("history"),
    more: cost("more"),
  }
  const full =
    drawn +
    (fit.copyLink ? needs.copyLink - needs.more : 0) +
    (fit.objects ? needs.objects : 0) +
    (fit.history ? needs.history : 0)
  return { full, ...needs }
}

const same = (a: BarFit, b: BarFit) =>
  a.copyLink === b.copyLink &&
  a.objects === b.objects &&
  a.history === b.history

/**
 * The second bar's fit, kept current: a ref callback for the bar and what
 * of it is in More. The bar marks its moving controls with
 * `data-bar-item` (`copy-link`, `objects`, `history`, `more`). Measured
 * when the bar mounts, when it is resized and after every render.
 */
export function useBarFit(): [(el: HTMLElement | null) => void, BarFit] {
  const [fit, setFit] = useState<BarFit>(ALL_ON_BAR)
  const fitRef = useRef(fit)
  fitRef.current = fit
  const bar = useRef<HTMLElement | null>(null)
  const seen = useRef<Partial<Record<Item, number>>>({})
  const measure = useCallback(() => {
    const el = bar.current
    if (!el) return
    const next = barFit(
      contentWidth(el),
      measureNeeds(el, fitRef.current, seen.current)
    )
    setFit((prev) => (same(prev, next) ? prev : next))
  }, [])
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      bar.current = el
      if (!el) return
      measure()
      if (typeof ResizeObserver === "undefined") return
      observer.current = new ResizeObserver(measure)
      observer.current.observe(el)
    },
    [measure]
  )
  // What the bar holds changes with the page's state, not its size.
  useLayoutEffect(measure)
  return [ref, fit]
}
