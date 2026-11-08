import { Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useMemo } from "react"

import type { DeviceRole, FloorTileTypeOption } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { BarTip } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { cn } from "@/lib/utils"

import type { PaletteEntry } from "./floor-canvas"
import { TileBadge } from "./tile-badge"

/** Layout mode's left rail: the tile types and device roles to place, as
 * Tiles and Background (zone) tabs. Click one to arm it. */
export function TilePalette({
  planId,
  tileTypes,
  roles,
  paletteTab,
  setPaletteTab,
  armed,
  setArmed,
}: {
  planId: string
  tileTypes: FloorTileTypeOption[] | undefined
  roles: DeviceRole[] | undefined
  paletteTab: "tiles" | "zones"
  setPaletteTab: (tab: "tiles" | "zones") => void
  armed: PaletteEntry | null
  setArmed: (next: (cur: PaletteEntry | null) => PaletteEntry | null) => void
}) {
  const palette = useMemo<PaletteEntry[]>(() => {
    const fromTypes = (tileTypes ?? []).map((tt): PaletteEntry => ({
      key: `tt:${tt.id}`,
      kind: "tile_type",
      id: tt.id,
      name: tt.name,
      color: tt.color,
      icon: tt.icon,
      defaultWidth: tt.default_width,
      defaultHeight: tt.default_height,
      isZone: tt.is_zone,
      hasFov: tt.has_fov,
    }))
    const fromRoles = (roles ?? []).map((r): PaletteEntry => ({
      key: `role:${r.id}`,
      kind: "role",
      id: r.id,
      name: r.name,
      color: r.color,
      icon: "",
      defaultWidth: 1,
      defaultHeight: 1,
      isZone: false,
      hasFov: r.has_fov,
    }))
    return [...fromTypes, ...fromRoles]
  }, [tileTypes, roles])

  const shownPalette = palette.filter((p) =>
    paletteTab === "zones" ? p.isZone : !p.isZone
  )

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Palette
        </span>
        <BarTip tip="Add tile type">
          <Button variant="ghost" size="icon-xs" asChild>
            <Link
              to="/floor-tile-types/new"
              search={{ from: planId }}
              aria-label="Add tile type"
            >
              <Plus className="size-3.5" />
            </Link>
          </Button>
        </BarTip>
      </div>
      <div className="px-2 pb-1">
        <SegmentedTabs<"tiles" | "zones">
          value={paletteTab}
          onValueChange={setPaletteTab}
          items={[
            {
              value: "tiles",
              label: "Tiles",
              count: palette.filter((p) => !p.isZone).length || null,
            },
            {
              value: "zones",
              label: "Background",
              count: palette.filter((p) => p.isZone).length || null,
            },
          ]}
        />
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2 pt-1">
        {paletteTab === "tiles" && shownPalette.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No tile types yet. Create “Rack”, “Wall”, “Cooling”… under{" "}
            <Link to="/floor-tile-types" className="underline">
              Customize → Floor tiles
            </Link>
            ; device roles show up here automatically.
          </p>
        )}
        {paletteTab === "zones" && shownPalette.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No background tiles yet. Create a tile type with the “Background
            zone” tick - a red “Hot aisle”, a blue “Cold aisle”, a security area
            - and paint it under your tiles.
          </p>
        )}
        {shownPalette.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() =>
              setArmed((cur) => (cur?.key === entry.key ? null : entry))
            }
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60",
              armed?.key === entry.key && "bg-muted ring-1 ring-foreground/20"
            )}
          >
            {/* A role is a colored catalog object: its badge, as
                everywhere else. A tile type shows its tile. */}
            {entry.kind === "role" ? (
              <ColorBadge
                name={entry.name}
                color={entry.color}
                className="max-w-full min-w-0 truncate"
              />
            ) : (
              <>
                <TileBadge color={entry.color} icon={entry.icon} />
                <span className="truncate">{entry.name}</span>
              </>
            )}
            {entry.hasFov && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                cam
              </span>
            )}
          </button>
        ))}
      </div>
      {armed && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          {armed.isZone
            ? `Drag across the area to paint ${armed.name} under your tiles. Esc to stop.`
            : `Click a cell to place a ${armed.name}; drag to paint a run. Esc to stop.`}
        </p>
      )}
    </aside>
  )
}
