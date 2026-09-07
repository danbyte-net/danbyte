import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlayClassName,
  size = "md",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** Extra classes for the backdrop overlay - e.g. inset it past the sidebar. */
  overlayClassName?: string
  /**
   * How wide the dialog gets. **Set this instead of passing a width class.**
   *
   * A `className` width override is unreliable here by construction: `cn()` is
   * tailwind-merge, which only dedupes classes carrying the *same* modifier, so
   * an unprefixed `max-w-lg` does NOT cancel a `sm:max-w-*` default - both land,
   * equal specificity, and Tailwind emits the variant later, so the default
   * wins on every desktop. Six dialogs shipped believing they were wide and
   * weren't. Keying off `data-size` can't be clobbered that way.
   *
   * sm 24rem · md 28rem (default) · lg 32rem · xl 36rem · 2xl 42rem · 3xl 48rem
   * · 4xl 56rem · 5xl 64rem · 6xl 72rem (review tables and other wide grids)
   */
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl"
}) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-size={size}
        className={cn(
          // max-h + overflow so a form taller than the viewport scrolls instead
          // of spilling off-screen unreachably (the generic "modal won't
          // scroll" bug). Callers that manage their own scroll region (flex
          // column with an inner overflow area) override via className.
          // Width: fit-content between a floor and the viewport. `size` is the
          // FLOOR, not a cap - a dialog holding something wider than its size
          // (a preview table, a long select) grows to fit rather than putting
          // a horizontal scrollbar inside itself; the viewport minus margin is
          // the only hard cap, and inner overflow-x wrappers engage only then
          // (phones). Form dialogs render exactly as before: their inputs
          // fill the floor.
          "fixed top-1/2 left-1/2 z-50 grid max-h-[90dvh] w-fit max-w-[calc(100vw-2rem)] min-w-[min(var(--dialog-w,28rem),calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto overscroll-contain rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          // The floor per data-size (see the prop doc for why not className).
          "data-[size=sm]:[--dialog-w:24rem] data-[size=md]:[--dialog-w:28rem] data-[size=lg]:[--dialog-w:32rem] data-[size=xl]:[--dialog-w:36rem] data-[size=2xl]:[--dialog-w:42rem] data-[size=3xl]:[--dialog-w:48rem] data-[size=4xl]:[--dialog-w:56rem] data-[size=5xl]:[--dialog-w:64rem] data-[size=6xl]:[--dialog-w:72rem]",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-4 right-4"
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading leading-none font-medium", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
