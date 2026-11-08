import { Suspense, lazy } from "react"

import { cn } from "@/lib/utils"

// `dynamic-icon` holds Lucide's whole icon map (about 460 KB). Chrome that
// every page renders, like the sidebar, draws a named icon through this
// wrapper so the map loads only when a custom or plugin icon is shown
// (#488). Pages that need icons by name anyway import `dynamic-icon` itself.
const DynamicIcon = lazy(() =>
  import("@/components/dynamic-icon").then((m) => ({ default: m.DynamicIcon }))
)

/** `DynamicIcon`, loaded on first use; an empty box of the same size holds
 * its place meanwhile. */
export function LazyDynamicIcon({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  return (
    <Suspense
      fallback={
        <span aria-hidden="true" className={cn("h-4 w-4", className)} />
      }
    >
      <DynamicIcon name={name} className={className} />
    </Suspense>
  )
}
