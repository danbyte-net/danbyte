import { useEffect, useRef, useState } from "react"

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
 */
export function useTableScroll(vertical = false) {
  const frameRef = useRef<HTMLDivElement>(null)
  const proxyRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const [showProxy, setShowProxy] = useState(false)

  useEffect(() => {
    const frame = frameRef.current
    const scroller = frame?.querySelector<HTMLElement>(
      "[data-slot=table-container]"
    )
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
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure)
      ro.observe(scroller)
      const table = scroller.querySelector("table")
      if (table) ro.observe(table)
    }
    const proxy = proxyRef.current
    proxy?.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      proxy?.removeEventListener("scroll", onScroll)
      ro?.disconnect()
      if (frameId) cancelAnimationFrame(frameId)
      scroller.removeAttribute("data-scroll-proxy")
    }
    // The proxy mounts when the table first overflows: re-bind then so its
    // scroll listener and scrollLeft are live.
  }, [vertical, showProxy])

  // A freshly mounted proxy starts at 0; line it up with the table.
  useEffect(() => {
    const scroller = frameRef.current?.querySelector<HTMLElement>(
      "[data-slot=table-container]"
    )
    if (showProxy && proxyRef.current && scroller) {
      proxyRef.current.scrollLeft = scroller.scrollLeft
    }
  }, [showProxy])

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
