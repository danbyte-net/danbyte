import { useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

// A long list in a scrolled panel, drawn only where it can be seen. The
// rows are cut into blocks; a block renders its rows while it is on or near
// the panel's view and is an empty box of the same height otherwise. A
// 2,400-device map's "On this map" list was ~17,000 elements, and every
// style recalculation on the page paid for all of them.

/** Rows per block; a list this short renders plainly. */
export const BLOCK = 50
/** How far past the panel's edges a block still renders. */
const MARGIN = 600

/** Within MARGIN of the panel's view? */
function nearView(el: HTMLElement, root: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  const view = root.getBoundingClientRect()
  return r.bottom >= view.top - MARGIN && r.top <= view.bottom + MARGIN
}

function Block({
  root,
  count,
  estimate,
  children,
}: {
  root: HTMLElement | null
  /** How many rows it holds: a height drawn for another count is stale. */
  count: number
  /** The block's height before it has rendered these rows. */
  estimate: number
  children: () => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const drawn = useRef<{ count: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === "undefined") {
      setNear(true)
      return
    }
    if (!root) return
    // Answered now, before the first paint - an observer answers a frame
    // late, and the rows in view would blink in.
    setNear(nearView(el, root))
    const io = new IntersectionObserver(
      (entries) => setNear(entries[entries.length - 1].isIntersecting),
      { root, rootMargin: `${MARGIN}px 0px` }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [root])
  // Remembered while the rows are in, so the empty box keeps their height.
  useLayoutEffect(() => {
    if (near && ref.current)
      drawn.current = { count, height: ref.current.offsetHeight }
  })
  const height =
    drawn.current?.count === count ? drawn.current.height : estimate
  return (
    <div ref={ref} style={near ? undefined : { height }}>
      {near ? children() : null}
    </div>
  )
}

/**
 * `rows` drawn with `row`, a block at a time once there are more than
 * BLOCK of them, in the panel `root` scrolls them in (null until it has
 * mounted). `estimate` is a row's height (px) for the blocks not yet drawn.
 */
export function LazyRows<T>({
  root,
  rows,
  row,
  estimate,
}: {
  root: HTMLElement | null
  rows: readonly T[]
  row: (item: T) => ReactNode
  estimate: number | ((item: T) => number)
}) {
  if (rows.length <= BLOCK) return <>{rows.map(row)}</>
  const blocks: T[][] = []
  for (let i = 0; i < rows.length; i += BLOCK)
    blocks.push(rows.slice(i, i + BLOCK))
  const heightOf = (items: T[]) =>
    typeof estimate === "number"
      ? items.length * estimate
      : items.reduce((h, item) => h + estimate(item), 0)
  return (
    <>
      {blocks.map((items, i) => (
        <Block
          key={i}
          root={root}
          count={items.length}
          estimate={heightOf(items)}
        >
          {() => items.map(row)}
        </Block>
      ))}
    </>
  )
}
