import { useMemo, useState } from "react"
import { Search } from "lucide-react"

import type { FloorPlanLiveState, FloorPlanTile } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  tileFill,
  tileIsZone,
  tileName,
} from "@/components/floorplan/floor-canvas"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { FoldableGroup } from "@/components/foldable-group"

interface Group {
  key: string
  title: string
  color: string
  icon: string
  tiles: FloorPlanTile[]
}

/** Group tiles by their type identity, ordered by name. */
function groupBy(
  tiles: FloorPlanTile[],
  pick: (
    t: FloorPlanTile
  ) => { id: string; name: string; icon?: string } | null | undefined
): Group[] {
  const map = new Map<string, Group>()
  for (const t of tiles) {
    const k = pick(t)
    if (!k) continue
    const g = map.get(k.id) ?? {
      key: k.id,
      title: k.name,
      color: tileFill(t),
      // Device roles carry no icon — TileBadge falls back to a colour chip,
      // exactly as the palette draws them.
      icon: k.icon ?? "",
      tiles: [],
    }
    g.tiles.push(t)
    map.set(k.id, g)
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      tiles: g.tiles.sort((a, b) =>
        tileName(a).localeCompare(tileName(b), undefined, { numeric: true })
      ),
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

const CHECK_TONE: Record<string, string> = {
  down: "bg-red-500",
  stale: "bg-red-500",
  degraded: "bg-amber-500",
  up: "bg-emerald-500",
}

/**
 * What's placed on this plan, listed and grouped.
 *
 * A tile carries EITHER a `role_type` (placed from the device-role palette) or
 * a `tile_type` — never both — so these are two disjoint sections rather than
 * two ways of slicing one list.
 *
 * Reads the page's live `tiles` array, so it tracks unsaved edits with no fetch
 * of its own.
 */
export function ObjectsSidebar({
  tiles,
  liveState,
  selectedId,
  onPick,
}: {
  tiles: FloorPlanTile[]
  liveState?: FloorPlanLiveState | null
  selectedId: string | null
  /** Select + focus the tile on the canvas. */
  onPick: (tile: FloorPlanTile) => void
}) {
  const [q, setQ] = useState("")

  const { roleGroups, typeGroups, total } = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // Zones are background paint, not placed objects — they'd drown the list.
    const placed = tiles.filter((t) => !tileIsZone(t))
    const match = needle
      ? placed.filter((t) =>
          [tileName(t), t.linked?.name, t.role_type?.name, t.tile_type?.name]
            .filter(Boolean)
            .some((s) => s!.toLowerCase().includes(needle))
        )
      : placed
    return {
      roleGroups: groupBy(match, (t) => t.role_type),
      typeGroups: groupBy(match, (t) => t.tile_type),
      total: match.length,
    }
  }, [tiles, q])

  const section = (label: string, groups: Group[]) =>
    groups.length > 0 && (
      <div className="mb-3">
        <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </p>
        {groups.map((g) => (
          <FoldableGroup
            key={g.key}
            title={g.title}
            badge={<TileBadge color={g.color} icon={g.icon} />}
            count={g.tiles.length}
          >
            {g.tiles.map((t) => {
              const live = liveState?.tiles[t.id]
              const tone = live?.check ? CHECK_TONE[live.check] : null
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onPick(t)}
                  className={cn(
                    "flex items-center gap-2 rounded px-1.5 py-1 pl-6 text-left text-[13px] hover:bg-muted/60",
                    t.id === selectedId && "bg-muted font-medium"
                  )}
                  title={tileName(t) || undefined}
                >
                  {tone && (
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", tone)}
                    />
                  )}
                  <span className="min-w-0 truncate">
                    {tileName(t) || (
                      <span className="text-muted-foreground">Unnamed</span>
                    )}
                  </span>
                </button>
              )
            })}
          </FoldableGroup>
        ))}
      </div>
    )

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-wide uppercase">
          On this plan
        </p>
        <span className="num text-[11px] text-muted-foreground">{total}</span>
      </div>
      <div className="relative mb-3">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search placed objects…"
          className="h-8 pl-7 text-[13px]"
        />
      </div>
      {total === 0 ? (
        <p className="px-1 text-[13px] text-muted-foreground">
          {tiles.length === 0 ? "Nothing placed yet." : "No matches."}
        </p>
      ) : (
        <>
          {section("Device roles", roleGroups)}
          {section("Tile types", typeGroups)}
        </>
      )}
    </aside>
  )
}
