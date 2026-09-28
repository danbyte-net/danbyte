import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// The toolbar parts every Maps page (Topology, Site map, Floor plans) builds
// its bars from, so a button, an icon button, a toggle and a menu trigger read
// the same on each. Controls are h-7 with text-xs and size-3 icons: the Button
// primitive has no h-7 size, which is why each page used to spell
// `size="sm" className="h-7 text-xs"` by hand.

/** Every icon in a bar control is size-3 unless it carries a `size-*` class.
 *  The first rule repeats the Button primitive's size-4 selector so
 *  tailwind-merge replaces that rule instead of stacking a second one. The
 *  second catches icons that selector skips: its `:not([class*='h-'])` also
 *  matches lucide's own class names, so Trash2 (`lucide-trash-2`) or
 *  RefreshCw would otherwise draw at their full 24px. */
const BAR =
  "h-7 text-xs [&_svg:not([class*='size-']):not([class*='h-'])]:size-3 [&_svg:not([class*='size-'])]:size-3"

type ButtonProps = React.ComponentProps<typeof Button>

/**
 * A one-line hint under a toolbar control: the plain chip tooltip, never the
 * rich panel. `shortcut` adds its key (e.g. `${modKey()}S`) after the text.
 */
export function BarTip({
  tip,
  shortcut,
  children,
}: {
  tip: React.ReactNode
  shortcut?: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" variant="default">
        {tip}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/** A labelled bar button: outline, h-7, text-xs. */
export function BarButton({
  className,
  variant = "outline",
  ...props
}: Omit<ButtonProps, "size">) {
  return (
    <Button
      variant={variant}
      size="sm"
      className={cn(BAR, className)}
      {...props}
    />
  )
}

/**
 * A square icon-only bar button. `label` is required and is both its
 * aria-label and its tooltip, so the two can't drift. `destructive` is the
 * quiet form for a delete: ghost with destructive text, no fill.
 */
export function BarIconButton({
  label,
  shortcut,
  destructive = false,
  className,
  ...props
}: Omit<ButtonProps, "size" | "variant" | "aria-label"> & {
  label: string
  shortcut?: string
  destructive?: boolean
}) {
  return (
    <BarTip tip={label} shortcut={shortcut}>
      <Button
        variant={destructive ? "ghost" : "outline"}
        size="icon-sm"
        aria-label={label}
        className={cn(
          BAR,
          "size-7",
          destructive && "text-destructive hover:text-destructive",
          className
        )}
        {...props}
      />
    </BarTip>
  )
}

/**
 * A labelled on/off bar button, such as a side-panel toggle. The state is
 * `aria-pressed`, and the label goes muted while it is off. The caller owns
 * `onClick`, since what "pressed" shows and what a click flips can differ.
 */
export function BarToggle({
  pressed,
  className,
  ...props
}: Omit<ButtonProps, "size" | "variant" | "aria-pressed"> & {
  pressed: boolean
}) {
  return (
    <BarButton
      aria-pressed={pressed}
      className={cn(!pressed && "text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * A labelled menu trigger: a bar button with a trailing chevron and no
 * tooltip - the label already says what the menu holds. It is only the
 * button; wrap it in the trigger of whatever it opens:
 *
 *   <DropdownMenuTrigger asChild>
 *     <BarMenuTrigger><Plus /> Add</BarMenuTrigger>
 *   </DropdownMenuTrigger>
 *
 * (or `PopoverTrigger asChild` for a popover such as Display).
 */
export function BarMenuTrigger({
  children,
  ...props
}: Omit<ButtonProps, "size">) {
  return (
    <BarButton {...props}>
      {children}
      <ChevronDown data-icon="inline-end" />
    </BarButton>
  )
}
