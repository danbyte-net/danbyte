import { Suspense } from "react"
import { ClientOnly } from "@tanstack/react-router"

import { Loading } from "@/components/loading"
import { lazyChunk } from "@/lib/lazy-chunk"
import { cn } from "@/lib/utils"
import type { MiniMapProps } from "./mini-map-view"

// Leaflet reads `window` as it loads, so the map module is only ever
// imported in the browser: a server render shows the loading box.
const MiniMapView = lazyChunk(() => import("./mini-map-view"))

export function MiniMap(props: MiniMapProps) {
  const fallback = (
    <div className={cn("relative", props.className)}>
      <Loading className="absolute inset-0 min-h-0" />
    </div>
  )
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <MiniMapView {...props} />
      </Suspense>
    </ClientOnly>
  )
}
