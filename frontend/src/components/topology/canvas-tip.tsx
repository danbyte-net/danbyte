import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import type { RefObject } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// One tooltip for the whole topology canvas, on the shared Tooltip primitive.
// A map holds thousands of cards, ports and cables; a Radix Tooltip per
// element would mount thousands of providers, so instead a single controlled
// instance follows the pointer:
//
//   - Card elements name themselves with a `data-tip` attribute and are
//     picked up by delegated pointer listeners on the canvas root.
//   - Edges have no DOM of their own to annotate, so the canvas drives the
//     tip imperatively from React Flow's edge hover callbacks.
//
// The trigger is a zero-size fixed anchor moved with the pointer (straight
// to the DOM - no re-render per mousemove), so a tip on a long cable can
// never sit off-screen the way a midpoint label does.

/** The attribute a canvas element sets to name itself on hover. */
export const TIP_ATTR = "data-tip"

/** The anchor sits this far down-right of the pointer, so the tip clears
 * the cursor. */
const NUDGE_X = 10
const NUDGE_Y = 8

type PointerLike = { clientX: number; clientY: number }

export interface CanvasTipHandle {
  /** Show `text` at the pointer; empty text hides. */
  show: (text: string | null | undefined, ev: PointerLike) => void
  move: (ev: PointerLike) => void
  hide: () => void
}

function tipTarget(t: EventTarget | null, root: HTMLElement): Element | null {
  if (!(t instanceof Element)) return null
  const el = t.closest(`[${TIP_ATTR}]`)
  return el && root.contains(el) ? el : null
}

export const CanvasTip = forwardRef<
  CanvasTipHandle,
  { root: RefObject<HTMLElement | null> }
>(function CanvasTip({ root }, ref) {
  const [text, setText] = useState<string | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)

  const place = useCallback((ev: PointerLike) => {
    const el = anchor.current
    if (!el) return
    el.style.left = `${ev.clientX + NUDGE_X}px`
    el.style.top = `${ev.clientY + NUDGE_Y}px`
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      show: (next, ev) => {
        place(ev)
        setText(next || null)
      },
      move: place,
      hide: () => setText(null),
    }),
    [place]
  )

  // Delegated hover for every `data-tip` element under the canvas root.
  useEffect(() => {
    const el = root.current
    if (!el) return
    let current: Element | null = null
    const over = (ev: PointerEvent) => {
      const t = tipTarget(ev.target, el)
      if (!t || t === current) return
      current = t
      place(ev)
      setText(t.getAttribute(TIP_ATTR) || null)
    }
    const move = (ev: PointerEvent) => {
      if (current) place(ev)
    }
    const out = (ev: PointerEvent) => {
      if (!current) return
      const next = tipTarget(ev.relatedTarget, el)
      if (next === current) return
      current = null
      // Moving straight onto another tip element: its pointerover follows
      // and takes over.
      if (!next) setText(null)
    }
    // A drag or click is not a hover - get out of the way.
    const down = () => {
      current = null
      setText(null)
    }
    el.addEventListener("pointerover", over)
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerout", out)
    el.addEventListener("pointerdown", down)
    return () => {
      el.removeEventListener("pointerover", over)
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerout", out)
      el.removeEventListener("pointerdown", down)
    }
  }, [root, place])

  return (
    <Tooltip open={!!text} onOpenChange={(open) => !open && setText(null)}>
      <TooltipTrigger asChild>
        <span
          ref={anchor}
          aria-hidden
          className="pointer-events-none fixed size-0"
        />
      </TooltipTrigger>
      <TooltipContent
        variant="panel"
        side="bottom"
        align="start"
        // Re-place every frame while open: the anchor moves with the
        // pointer without React knowing.
        updatePositionStrategy="always"
        className="pointer-events-none max-w-96 px-2 py-1 font-mono text-[11px]"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
})
