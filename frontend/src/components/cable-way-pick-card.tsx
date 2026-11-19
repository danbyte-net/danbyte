import { useEffect } from "react"
import { Link } from "@tanstack/react-router"
import { X } from "lucide-react"

import { useCableWayStore } from "@/lib/cable-way-store"
import type { CableWayStore } from "@/lib/cable-way-store"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import type { SceneWay } from "@/components/floorplan3d/way-geometry"

/**
 * The cable picked in a rack's 3D view (docs/dcim/racks.md → Cable ways →
 * In 3D): its label, its ports in this rack, whether its way is recorded
 * or only proposed, its in-rack length and a link to the cable. Esc or ×
 * lets it go. Outside the canvas; the ways layer lights the cable.
 */
export function PickedWayCard({
  store,
  ways,
  className,
}: {
  store: CableWayStore
  ways: readonly SceneWay[]
  className?: string
}) {
  const picked = useCableWayStore(store)
  const way = picked ? ways.find((w) => w.cable_id === picked) : undefined
  useEffect(() => {
    if (!picked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.select(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [store, picked])
  if (!way) return null
  return (
    <div
      className={cn(
        "pointer-events-auto absolute z-10 min-w-56 rounded-md border border-border bg-popover/95 px-3 py-2 text-xs text-popover-foreground shadow-md",
        className ?? "bottom-2 left-2"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold whitespace-nowrap">
          {way.label || "Cable"}
        </span>
        <Badge variant={way.state === "recorded" ? "secondary" : "outline"}>
          {way.state === "recorded" ? "Recorded" : "Proposed"}
        </Badge>
        <button
          type="button"
          aria-label="Close"
          className="ml-auto rounded-md p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => store.select(null)}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="mt-1 font-mono whitespace-nowrap">
        {way.ends.map((e) => (
          <div key={e.end}>
            {e.end} · {e.port}
          </div>
        ))}
      </div>
      {way.length_mm != null && (
        <div className="num mt-1 text-muted-foreground">
          {(way.length_mm / 1000).toFixed(2)} m in this rack
        </div>
      )}
      <Link
        to="/cables/$id"
        params={{ id: way.cable_id }}
        className="mt-1 inline-block text-primary hover:underline"
      >
        Open cable
      </Link>
    </div>
  )
}
