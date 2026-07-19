import { LoaderIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// shadcn/ui Spinner. A single lucide LoaderIcon spun with `animate-spin`.
//
// The extra hardening exists to kill a browser rendering quirk: clicking (and
// slightly dragging) an inline SVG starts a native image-drag, which *pauses*
// the CSS animation and freezes the icon mid-spin — the frozen frame reads as
// "the circle straightens out / spawns a tail". `draggable={false}` stops the
// native drag; `pointer-events-none` keeps it from ever being the click target;
// `select-none` prevents a text-selection caret. Together they make the spinner
// inert to the pointer so it just spins.
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  // `draggable: false` goes through the spread because neither React's SVGProps
  // nor lucide's prop type lists it, but React still forwards it to the
  // underlying <svg> at runtime — which is what stops the native image-drag.
  const svgProps: React.ComponentProps<"svg"> & { draggable?: boolean } = {
    draggable: false,
    ...props,
  }
  return (
    <LoaderIcon
      role="status"
      aria-label="Loading"
      className={cn(
        "pointer-events-none size-4 animate-spin select-none",
        className
      )}
      {...svgProps}
    />
  )
}

export { Spinner }
