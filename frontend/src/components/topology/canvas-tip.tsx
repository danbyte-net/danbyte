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
//
// Two looks, as everywhere else: a name on the map (a port, a device, a
// cable's identity) is the mono panel tip; a short word for a control
// ("Move", "Rename", "Slate") is the plain chip. An element opts into the
// chip with `data-tip-plain`.

/** The attribute a canvas element sets to name itself on hover. */
export const TIP_ATTR = "data-tip"
/** Present (any value) on a `data-tip` element whose tip is a plain word for
 * a control rather than a name: it gets the default chip, not the panel. */
export const TIP_PLAIN_ATTR = "data-tip-plain"

type Tip = { text: string; plain: boolean }

/** The anchor sits this far down-right of the pointer, so the tip clears
 * the cursor. */
const NUDGE_X = 10
const NUDGE_Y = 8

type PointerLike = { clientX: number; clientY: number }

export interface CanvasTipHandle {
  /** Show `text` at the pointer; empty text hides. `plain` = the chip look,
   * for a word rather than a name. */
  show: (
    text: string | null | undefined,
    ev: PointerLike,
    plain?: boolean
  ) => void
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
  const [tip, setShown] = useState<Tip | null>(null)
  // The last tip shown, which the chip keeps drawing while it fades out -
  // so a closing tip neither empties nor changes its look.
  const [last, setLast] = useState<Tip | null>(null)
  const setTip = useCallback((next: Tip | null) => {
    setShown(next)
    if (next) setLast(next)
  }, [])
  const anchor = useRef<HTMLSpanElement>(null)
  // The delegated `data-tip` element that owns the tip, or null while an
  // edge (or nothing) does. Leaving a cable straight onto a port fires the
  // port's pointerover before React Flow's edge mouseleave, so the edge's
  // hide() must not wipe a tip the port has already taken over.
  const owner = useRef<Element | null>(null)

  const place = useCallback((ev: PointerLike) => {
    const el = anchor.current
    if (!el) return
    el.style.left = `${ev.clientX + NUDGE_X}px`
    el.style.top = `${ev.clientY + NUDGE_Y}px`
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      show: (next, ev, plain = false) => {
        owner.current = null
        place(ev)
        setTip(next ? { text: next, plain } : null)
      },
      move: place,
      hide: () => {
        if (!owner.current) setTip(null)
      },
    }),
    [place, setTip]
  )

  // Delegated hover for every `data-tip` element under the canvas root.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const over = (ev: PointerEvent) => {
      const t = tipTarget(ev.target, el)
      if (!t || t === owner.current) return
      owner.current = t
      place(ev)
      const text = t.getAttribute(TIP_ATTR)
      setTip(text ? { text, plain: t.hasAttribute(TIP_PLAIN_ATTR) } : null)
    }
    const move = (ev: PointerEvent) => {
      if (owner.current) place(ev)
    }
    const out = (ev: PointerEvent) => {
      if (!owner.current) return
      const next = tipTarget(ev.relatedTarget, el)
      if (next === owner.current) return
      owner.current = null
      // Moving straight onto another tip element: its pointerover follows
      // and takes over.
      if (!next) setTip(null)
    }
    // A drag or click is not a hover - get out of the way.
    const down = () => {
      owner.current = null
      setTip(null)
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
  }, [root, place, setTip])

  return (
    <Tooltip open={!!tip} onOpenChange={(open) => !open && setTip(null)}>
      <TooltipTrigger asChild>
        <span
          ref={anchor}
          aria-hidden
          className="pointer-events-none fixed size-0"
        />
      </TooltipTrigger>
      <TooltipContent
        variant={last?.plain ? "default" : "panel"}
        side="bottom"
        align="start"
        // Re-place every frame while open: the anchor moves with the
        // pointer without React knowing.
        updatePositionStrategy="always"
        className={
          last?.plain
            ? "pointer-events-none"
            : "pointer-events-none max-w-96 px-2 py-1 font-mono text-[11px]"
        }
      >
        {last?.text}
      </TooltipContent>
    </Tooltip>
  )
})
