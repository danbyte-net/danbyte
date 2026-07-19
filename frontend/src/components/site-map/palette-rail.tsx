import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Building2, Plus } from "lucide-react"

import type { SiteMapSite } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TileBadge } from "@/components/floorplan/tile-badge"
import type { MarkerTypeOption } from "@/components/site-map/map-sidebar"
import { cn } from "@/lib/utils"

// The site map's LEFT palette rail — a clone of the floor planner's palette.
// Visible only in edit mode. Tabs switch what you're placing; click-to-arm,
// then click the map. Marker types stay armed so several can be stamped.

export function MapPaletteRail({
  sites,
  placing,
  onPlaceSite,
  markerTypes,
  onArmMarkerType,
}: {
  sites: SiteMapSite[]
  placing: { kind: string; id: string; name: string } | null
  onPlaceSite: (s: SiteMapSite) => void
  markerTypes: MarkerTypeOption[]
  onArmMarkerType: (t: MarkerTypeOption) => void
}) {
  const [tab, setTab] = useState<"sites" | "markers">("sites")
  const unplaced = sites.filter((s) => s.latitude === null)

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Palette
        </span>
        <Button variant="ghost" size="sm" asChild className="h-6 px-1.5">
          <Link to="/floor-tile-types/new" title="Add marker type">
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
      <div className="px-2 pb-1">
        <SegmentedTabs<"sites" | "markers">
          value={tab}
          onValueChange={setTab}
          items={[
            {
              value: "sites",
              label: "Sites",
              count: unplaced.length || null,
            },
            { value: "markers", label: "Markers" },
          ]}
        />
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto p-2 pt-1">
        {tab === "sites" &&
          (unplaced.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              Every site is placed. Drag a pin to move it, or add coordinates
              from the site form.
            </p>
          ) : (
            unplaced.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={!s.can_edit}
                onClick={() => onPlaceSite(s)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60 disabled:opacity-50",
                  placing?.kind === "site" &&
                    placing.id === s.id &&
                    "bg-muted ring-1 ring-foreground/20"
                )}
              >
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5" />
                </span>
                <span className="truncate">{s.name}</span>
              </button>
            ))
          ))}

        {tab === "markers" && (
          <>
            {markerTypes.length === 0 && (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                No marker types yet. Tile types (Customize → Floor tiles) and
                device roles show up here automatically.
              </p>
            )}
            {markerTypes.map((t) => (
              <button
                key={`${t.kind}:${t.id}`}
                type="button"
                onClick={() => onArmMarkerType(t)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60",
                  placing?.kind === "marker" &&
                    placing.id === t.id &&
                    "bg-muted ring-1 ring-foreground/20"
                )}
              >
                <TileBadge color={t.color} icon={t.icon} />
                <span className="truncate">{t.name}</span>
                {(t.kind === "role" || t.has_fov) && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {t.kind === "role" ? "role" : "cam"}
                  </span>
                )}
              </button>
            ))}
          </>
        )}
      </div>

      {placing && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          {placing.kind === "marker"
            ? `Click the map to stamp ${placing.name} — stays armed. Esc to stop.`
            : `Click the map to place ${placing.name}. Esc to stop.`}
        </p>
      )}
    </aside>
  )
}
