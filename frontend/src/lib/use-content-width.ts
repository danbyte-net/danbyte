import { useEffect, useState } from "react"

/** An element's content width in px, following its resizes; 0 until it is
 * laid out. Takes the element itself - from a callback ref - so it measures
 * one that mounts late too. */
export function useContentWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return width
}
