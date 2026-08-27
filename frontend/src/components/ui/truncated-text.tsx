import { useEffect, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * Text that truncates to its container and reveals itself on hover - but only
 * when it is *actually* clipped (#124).
 *
 * A long device-type name used to push its field into the one beside it. The
 * fix is `truncate`, which then hides the part you needed. Measuring rather
 * than guessing is what keeps the tooltip useful: a tooltip that repeats a
 * short label in full is noise on every control in the app.
 */
export function TruncatedText({
  children,
  className,
  title,
}: {
  /** The visible text. Also what the tooltip shows, unless `title` overrides. */
  children: ReactNode
  className?: string
  /** Tooltip text, when the rendered children aren't a plain string. */
  title?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setClipped(el.scrollWidth > el.clientWidth + 1)
    check()
    // The field can be resized by the form's own columns, not just the window,
    // so watch the element rather than listening for a window resize.
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])

  const span = (
    <span ref={ref} className={cn("min-w-0 truncate", className)}>
      {children}
    </span>
  )
  const full = title ?? (typeof children === "string" ? children : "")
  if (!clipped || !full) return span
  return (
    <Tooltip>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  )
}
