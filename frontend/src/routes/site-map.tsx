import { Suspense } from "react"
import { ClientOnly, createFileRoute } from "@tanstack/react-router"

import { Loading } from "@/components/loading"
import { lazyChunk } from "@/lib/lazy-chunk"

// The page is a Leaflet map, and Leaflet reads `window` as it loads: the
// page module (components/site-map/site-map-page.tsx) is only ever imported
// in the browser, so a server render never loads it.
const SiteMapPage = lazyChunk(
  () => import("@/components/site-map/site-map-page")
)

export const Route = createFileRoute("/site-map")({
  // ?focus=<deviceId> · ?trace=<cableId> - arrive centered on a device (the
  // "Show on site map" quick button on device detail pages), or with a
  // routed cable highlighted (the "Show on site map" cable button).
  validateSearch: (
    s: Record<string, unknown>
  ): { focus?: string; trace?: string } => ({
    ...(typeof s.focus === "string" ? { focus: s.focus } : {}),
    ...(typeof s.trace === "string" ? { trace: s.trace } : {}),
  }),
  component: SiteMapRoute,
})

function SiteMapRoute() {
  return (
    <ClientOnly fallback={<Loading />}>
      <Suspense fallback={<Loading />}>
        <SiteMapPage />
      </Suspense>
    </ClientOnly>
  )
}
