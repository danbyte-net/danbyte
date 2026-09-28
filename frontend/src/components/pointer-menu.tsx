import { useEffect, useRef } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/** Where a pointer menu opens: viewport coordinates, as a right-click's
 * `clientX` / `clientY`. */
export interface PointerMenuAt {
  x: number
  y: number
}

/** Shortcut keys a pointer menu answers while open. */
export type MenuKeys = Partial<Record<string, () => void>>

/**
 * A right-click menu on a canvas: the shared DropdownMenu, controlled, and
 * anchored at the pointer instead of a button. Open it by setting `menu`
 * (anything with the click's `x` and `y`); a pick, Escape or a click
 * anywhere else closes it through `onClose`.
 *
 * `children` renders the items for the menu that is open. It is called with
 * the last menu while the closing one fades out, so the items do not vanish
 * from under the animation.
 *
 * A right-click that closes the menu only closes it: the browser's own
 * context menu stays shut, as it would with the old overlay.
 *
 * `keys` lets the open menu answer the shortcuts its items show (H for
 * Hide, Del for Remove): pressed while it is open, they act on the thing
 * right-clicked, not on whatever the canvas has selected, and close it.
 */
export function PointerMenu<T extends PointerMenuAt>({
  menu,
  onClose,
  label,
  className,
  keys,
  children,
}: {
  menu: T | null
  onClose: () => void
  /** The menu's accessible name, e.g. "Device". */
  label?: string
  className?: string
  /** The open menu's shortcuts, by `KeyboardEvent.key` with letters in
   * lower case ("h", "Delete"). A key pressed with Ctrl, Alt, Meta or
   * Shift is left to the page. */
  keys?: (menu: T) => MenuKeys
  children: (menu: T) => React.ReactNode
}) {
  const last = useRef<T | null>(menu)
  if (menu) last.current = menu
  const shown = menu ?? last.current

  const open = useRef(false)
  open.current = !!menu
  useEffect(() => {
    // The menu closes on the right button's pointerdown; the contextmenu
    // event comes after (on mouseup on some platforms), when it is shut.
    // So note at pointerdown whether this press is the one that closes it.
    let swallow = false
    const down = (e: PointerEvent) => {
      swallow = open.current && e.button === 2
    }
    const context = (e: MouseEvent) => {
      if (swallow || open.current) {
        e.preventDefault()
        e.stopPropagation()
      }
      swallow = false
    }
    window.addEventListener("pointerdown", down, true)
    window.addEventListener("contextmenu", context, true)
    return () => {
      window.removeEventListener("pointerdown", down, true)
      window.removeEventListener("contextmenu", context, true)
    }
  }, [])

  return (
    <DropdownMenu
      open={!!menu}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-0"
          style={{ left: shown?.x ?? 0, top: shown?.y ?? 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        collisionPadding={8}
        aria-label={label}
        className={cn("w-56", className)}
        // Nothing to hand the focus back to: the anchor is a point. And an
        // item that opens an editor (Rename, Add text) keeps its focus.
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Ahead of the menu's type-to-find, and of the page's own key
        // listeners, which act on the selection.
        onKeyDown={(e) => {
          if (!menu || !keys) return
          if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
          const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
          const run = keys(menu)[key]
          if (!run) return
          e.preventDefault()
          e.stopPropagation()
          run()
          onClose()
        }}
      >
        {shown && children(shown)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
