import { Suspense, lazy } from "react"

import type { IconPickerProps } from "@/components/icon-picker"
import { cn } from "@/lib/utils"

// The icon picker needs Lucide's whole icon map. The shared form fields are
// in the main bundle, so they load the picker on first render instead of
// carrying the map on every page (#488).
const IconPicker = lazy(() =>
  import("@/components/icon-picker").then((m) => ({ default: m.IconPicker }))
)

/** `IconPicker`, loaded on first use; an empty trigger of the same size holds
 * its place meanwhile. */
export function LazyIconPicker(props: IconPickerProps) {
  return (
    <Suspense
      fallback={
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-9 w-40 rounded-md border border-border",
            props.className
          )}
        />
      }
    >
      <IconPicker {...props} />
    </Suspense>
  )
}
