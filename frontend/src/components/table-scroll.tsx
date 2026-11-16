import { useEffect, useRef, useState, type ReactNode, type Ref } from "react"

import { cn } from "@/lib/utils"

/**
 * Horizontal scrolling help for a wide table: a floating scrollbar and edge
 * hints. `frameRef` is the bordered frame around a shadcn `<Table>`; the
 * element that scrolls is the table container inside it.
 *
 * - While the table overflows, {@link TableScrollProxy} renders a thin proxy
 *   scrollbar after the frame. It is `position: sticky; bottom: 0`, so it
 *   floats at the bottom of the viewport while the table is on screen and
 *   settles under the table once its end scrolls into view. The proxy and
 *   the table container mirror each other's `scrollLeft`, and the
 *   container's own bar is hidden (`data-scroll-proxy`) so only one shows.
 * - The frame gets `data-scroll-left` / `data-scroll-right` while there is
 *   more to see on that side; styles.css draws a soft inset shadow there.
 *
 * `vertical`: the container is a fixed-height scroller (a sticky-header
 * pane). When it does scroll vertically its native bar already sits at the
 * pane's bottom edge, so the proxy stays out of the way.
 *
 * `selector` names the scroller inside the frame: a shadcn Table's container
 * by default, or {@link HScroll}'s viewport for content that is not a table.
 */
export function useTableScroll(
  vertical = false,
  selector = "[data-slot=table-container]"
) {
  const frameRef = useRef<HTMLDivElement>(null)
  const proxyRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const [showProxy, setShowProxy] = useState(false)

  useEffect(() => {
    const frame = frameRef.current
    const scroller = frame?.querySelector<HTMLElement>(selector)
    if (!frame || !scroller) return
    let frameId = 0
    let pendingFrom: HTMLElement | null = null

    const edges = () => {
      const max = scroller.scrollWidth - scroller.clientWidth
      const left = scroller.scrollLeft
      frame.toggleAttribute("data-scroll-left", max > 1 && left > 1)
      frame.toggleAttribute("data-scroll-right", max > 1 && left < max - 1)
    }

    const measure = () => {
      const overflows = scroller.scrollWidth > scroller.clientWidth + 1
      const scrollsDown =
        vertical && scroller.scrollHeight > scroller.clientHeight + 1
      const show = overflows && !scrollsDown
      if (spacerRef.current)
        spacerRef.current.style.width = `${scroller.scrollWidth}px`
      // A sticky box stops at the page scroller's padding, so rows would
      // show through the gap under it: sit in that padding instead.
      const proxy = proxyRef.current
      if (proxy) {
        let page = proxy.parentElement
        while (page && !/auto|scroll/.test(getComputedStyle(page).overflowY))
          page = page.parentElement
        const pad = page ? getComputedStyle(page).paddingBottom : "0px"
        proxy.style.bottom = `calc(-1 * ${pad || "0px"})`
      }
      scroller.toggleAttribute("data-scroll-proxy", show)
      setShowProxy(show)
      edges()
    }

    // One sync per frame; the side that scrolled last leads. Setting the
    // other side fires its own scroll event, which finds both equal and
    // stops - no feedback loop.
    const sync = () => {
      frameId = 0
      const from = pendingFrom
      pendingFrom = null
      const proxy = proxyRef.current
      if (from && proxy) {
        const to = from === scroller ? proxy : scroller
        if (Math.abs(to.scrollLeft - from.scrollLeft) >= 1)
          to.scrollLeft = from.scrollLeft
      }
      edges()
    }
    const onScroll = (e: Event) => {
      pendingFrom = e.currentTarget as HTMLElement
      if (!frameId) frameId = requestAnimationFrame(sync)
    }

    scroller.addEventListener("scroll", onScroll, { passive: true })
    measure()
    // The scroller's own size and its children's (the table, or the items
    // of a wide row) - together they cover every change to scrollWidth.
    let ro: ResizeObserver | undefined
    let mo: MutationObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      const r = new ResizeObserver(measure)
      ro = r
      const watch = () => {
        r.disconnect()
        r.observe(scroller)
        for (const child of Array.from(scroller.children)) r.observe(child)
      }
      watch()
      if (typeof MutationObserver !== "undefined") {
        mo = new MutationObserver(() => {
          watch()
          measure()
        })
        mo.observe(scroller, { childList: true })
      }
    }
    const proxy = proxyRef.current
    proxy?.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      proxy?.removeEventListener("scroll", onScroll)
      ro?.disconnect()
      mo?.disconnect()
      if (frameId) cancelAnimationFrame(frameId)
      scroller.removeAttribute("data-scroll-proxy")
    }
    // The proxy mounts when the table first overflows: re-bind then so its
    // scroll listener and scrollLeft are live.
  }, [vertical, selector, showProxy])

  // A freshly mounted proxy starts at 0; line it up with the table.
  useEffect(() => {
    const scroller = frameRef.current?.querySelector<HTMLElement>(selector)
    if (showProxy && proxyRef.current && scroller) {
      proxyRef.current.scrollLeft = scroller.scrollLeft
    }
  }, [selector, showProxy])

  return { frameRef, proxyRef, spacerRef, showProxy }
}

/** The floating scrollbar for {@link useTableScroll}. Place it straight after
 * the frame. Hidden when printing. */
export function TableScrollProxy({
  scroll,
  className,
}: {
  scroll: ReturnType<typeof useTableScroll>
  className?: string
}) {
  if (!scroll.showProxy) return null
  return (
    <div
      ref={scroll.proxyRef}
      data-slot="table-scroll-proxy"
      aria-hidden
      tabIndex={-1}
      className={cn(
        "sticky bottom-0 z-10 mx-px h-3 overflow-x-auto overflow-y-hidden bg-background print:hidden",
        className
      )}
    >
      <div ref={scroll.spacerRef} className="h-px" />
    </div>
  )
}

const VIEWPORT = "[data-slot=hscroll-viewport]"

/**
 * Wide content that is not a table - a rack wall, a zoomed drawing, a
 * hand-built grid - scrolling sideways with the same floating scrollbar and
 * edge hints as DataTable, so its horizontal bar is at the bottom of the view
 * rather than after the last row. The frame (`frameClassName`: border,
 * radius, background) holds a viewport (`className`: the content's own
 * layout) that scrolls; `viewportRef` reaches it for callers that measure.
 *
 * While it overflows the viewport is a named, focusable region, so arrow
 * keys scroll it. It prints at full width, never clipped.
 */
export function HScroll({
  children,
  className,
  frameClassName,
  outerClassName,
  viewportRef,
  label,
}: {
  children: ReactNode
  className?: string
  frameClassName?: string
  outerClassName?: string
  viewportRef?: Ref<HTMLDivElement>
  /** Accessible name for the scrollable region. */
  label?: string
}) {
  const scroll = useTableScroll(false, VIEWPORT)
  const scrolls = scroll.showProxy
  return (
    <div className={cn("min-w-0", outerClassName)}>
      <div ref={scroll.frameRef} className={cn("relative", frameClassName)}>
        <div
          ref={viewportRef}
          data-slot="hscroll-viewport"
          role={scrolls ? "region" : undefined}
          aria-label={scrolls ? label : undefined}
          tabIndex={scrolls ? 0 : undefined}
          className={cn(
            "overflow-x-auto rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring print:overflow-visible",
            className
          )}
        >
          {children}
        </div>
      </div>
      <TableScrollProxy scroll={scroll} />
    </div>
  )
}

/**
 * The bordered frame around a shadcn `<Table>` outside DataTable: the
 * table's own container scrolls, with the floating scrollbar and edge hints.
 * `className` styles the frame.
 */
export function ScrollFrame({
  children,
  className,
  outerClassName,
}: {
  children: ReactNode
  className?: string
  outerClassName?: string
}) {
  const scroll = useTableScroll()
  return (
    <div className={cn("min-w-0", outerClassName)}>
      <div
        ref={scroll.frameRef}
        className={cn("relative overflow-hidden", className)}
      >
        {children}
      </div>
      <TableScrollProxy scroll={scroll} />
    </div>
  )
}
