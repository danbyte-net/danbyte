import { Link } from "@tanstack/react-router"

import { MiniMap } from "@/components/site-map/mini-map"

// Dashboard widget: a real OSM mini-map of your sites, devices, cables, and
// connections, with a corner link into the full Site map.
export function OsmMapWidget() {
  return (
    <div className="relative h-56 overflow-hidden">
      <MiniMap className="h-full w-full" />
      <Link
        to="/site-map"
        className="absolute right-2 bottom-2 z-[500] rounded-md border border-border bg-background/85 px-2 py-1 text-[11px] backdrop-blur hover:bg-background"
        title="Open the full Site map"
      >
        Open map →
      </Link>
    </div>
  )
}
