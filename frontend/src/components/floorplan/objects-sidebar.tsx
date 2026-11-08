import { useMemo, useState } from "react"

import type { FloorPlanLiveState, FloorPlanTile } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  tileFill,
  tileIsZone,
  tileName,
} from "@/components/floorplan/floor-canvas"
import { ColorBadge } from "@/components/cells/color-badge"
import { getLucideIcon } from "@/components/dynamic-icon"
import { tileIcon } from "@/components/object-icon"
import {
  CheckCountBadge,
  FoldableGroup,
  RowCheckBadge,
  VisibilityToggle,
} from "@/components/foldable-group"
import {
  NO_FLOOR_HIDDEN,
  placedGroupKey,
  tileHidden,
} from "@/components/floorplan/hidden"
import type { FloorHidden } from "@/components/floorplan/hidden"
import { hiddenCount, isHidden, setHidden } from "@/components/hidden-objects"
import {
  ObjectsEmpty,
  ObjectsPanel,
  ObjectsSection,
  checkCounts,
} from "@/components/objects-panel"
import type { CheckFilter } from "@/components/objects-panel"
import { TruncatedText } from "@/components/ui/truncated-text"
import { naturalCompare } from "@/lib/natural-sort"
import {
  areaColor,
  areaFallbackName,
  areaName,
} from "@/components/floorplan/shapes"
import type { PlanShape } from "@/components/floorplan/shapes"
import { LINK_KIND_NAME } from "@/components/floorplan/tile-open"

/** A placed object with no role: grouped by its kind. */
const KIND_TITLE: Partial<Record<string, string>> = Object.fromEntries(
  Object.entries(LINK_KIND_NAME).map(([k, n]) => [k, n.many])
)

interface Group {
  key: string
  title: string
  color: string
  tiles: FloorPlanTile[]
}

/** A row's icon: the one its tile draws with from afar (object-icon.ts),
 * or nothing for a planning tile without one. */
function TileIconGlyph({ tile }: { tile: FloorPlanTile }) {
  const Icon = getLucideIcon(tileIcon(tile))
  if (!Icon) return null
  return (
    <Icon
      data-part="row-icon"
      aria-hidden="true"
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  )
}

/** Group tiles by their type identity, ordered by name. */
function groupBy(
  tiles: FloorPlanTile[],
  pick: (
    t: FloorPlanTile
  ) => { id: string; name: string; color?: string | null } | null | undefined
): Group[] {
  const map = new Map<string, Group>()
  for (const t of tiles) {
    const k = pick(t)
    if (!k) continue
    const g = map.get(k.id) ?? {
      key: k.id,
      title: k.name,
      // The type's own color - a tile's override paints only that tile.
      color: k.color || tileFill(t),
      tiles: [],
    }
    g.tiles.push(t)
    map.set(k.id, g)
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      tiles: g.tiles.sort((a, b) => naturalCompare(tileName(a), tileName(b))),
    }))
    .sort((a, b) => naturalCompare(a.title, b.title))
}

/**
 * The floor plan's Objects sidebar: what's placed on this plan, listed and
 * grouped - the same panel the site map and the topology map open.
 *
 * A tile carries EITHER a `role_type` (placed from the device-role palette) or
 * a `tile_type` - never both - so these are two disjoint sections rather than
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
  hidden = NO_FLOOR_HIDDEN,
  onHiddenChange,
  omitRacks = false,
  shapes = [],
  selectedShapeId = null,
  onPickShape,
  unplaced,
  cellMm,
}: {
  /** The plan's cell size, mm: an area with no name is listed by its size. */
  cellMm?: number
  /** Edit: the floor's objects not placed anywhere (drag onto the plan). */
  unplaced?: React.ReactNode
  /** The plan's areas and labels (hidden ones included, dimmed). */
  shapes?: PlanShape[]
  selectedShapeId?: string | null
  /** Select + focus an area or a label. */
  onPickShape?: (shape: PlanShape) => void
  tiles: FloorPlanTile[]
  liveState?: FloorPlanLiveState | null
  selectedId: string | null
  /** Select + focus the tile on the canvas. */
  onPick: (tile: FloorPlanTile) => void
  /** The eyes: a type, a role or one tile taken off the plan. The list keeps
   * every tile, dimmed when hidden, so it can be brought back. */
  hidden?: FloorHidden
  onHiddenChange?: (next: FloorHidden) => void
  /** Leave out the tiles linked to a rack: the rack table under the plan
   * lists them while the plan is coloured by its racks. */
  omitRacks?: boolean
}) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<CheckFilter>(null)
  const eyes = !!onHiddenChange
  const toggle = (key: keyof FloorHidden, value: string, shown: boolean) =>
    onHiddenChange?.(setHidden(hidden, key, value, !shown))
  const checkOf = (t: FloorPlanTile) => liveState?.tiles[t.id]?.check ?? null

  const { roleGroups, typeGroups, objectGroups, total, statusCounts, first } =
    useMemo(() => {
      const needle = q.trim().toLowerCase()
      // Zones are background paint, not placed objects - they'd drown the list.
      const placed = tiles.filter(
        (t) => !tileIsZone(t) && !(omitRacks && t.linked?.kind === "rack")
      )
      const searched = needle
        ? placed.filter((t) =>
            [tileName(t), t.linked?.name, t.role_type?.name, t.tile_type?.name]
              .filter(Boolean)
              .some((s) => s!.toLowerCase().includes(needle))
          )
        : placed
      const match = status
        ? searched.filter((t) => liveState?.tiles[t.id]?.check === status)
        : searched
      const byRole = groupBy(match, (t) => t.role_type)
      const byType = groupBy(match, (t) => t.tile_type)
      // Placed straight from an object: no type, grouped by the object's role.
      const byObject = groupBy(
        match.filter((t) => !t.tile_type && !t.role_type && t.linked),
        (t) => ({
          id: placedGroupKey(t),
          name:
            t.linked?.role?.name ?? KIND_TITLE[t.linked?.kind ?? ""] ?? "Other",
          color: t.linked?.role?.color ?? null,
        })
      )
      return {
        roleGroups: byRole,
        typeGroups: byType,
        objectGroups: byObject,
        total: match.length,
        statusCounts: checkCounts(
          searched.map((t) => liveState?.tiles[t.id]?.check)
        ),
        first:
          byObject.at(0)?.tiles.at(0) ??
          byRole.at(0)?.tiles.at(0) ??
          byType.at(0)?.tiles.at(0),
      }
    }, [tiles, q, status, liveState, omitRacks])

  // Areas and labels: no monitoring of their own, so the status filter
  // leaves them out.
  const { areaRows, labelRows } = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = (s: string) => !needle || s.toLowerCase().includes(needle)
    const named = (s: PlanShape) =>
      s.kind === "area" ? areaName(s) || areaFallbackName(s, cellMm) : s.text
    const rows = status ? [] : shapes.filter((s) => match(named(s)))
    // Named areas first, the outlines with no name after them.
    const unnamed = (s: PlanShape) =>
      s.kind === "area" && !areaName(s) ? 1 : 0
    const sort = (a: PlanShape, b: PlanShape) =>
      unnamed(a) - unnamed(b) || naturalCompare(named(a), named(b))
    return {
      areaRows: rows.filter((s) => s.kind === "area").sort(sort),
      labelRows: rows.filter((s) => s.kind === "label").sort(sort),
    }
  }, [shapes, q, status, cellMm])

  const shapeRow = (s: PlanShape) => {
    const key = s.kind === "area" ? "areas" : "labels"
    const off = eyes && isHidden(hidden, key, s.id)
    const name =
      s.kind === "area" ? areaName(s) : s.text.split("\n")[0] || "Label"
    return (
      <div
        key={s.id}
        className={cn(
          "flex items-center gap-1.5 rounded pr-1 hover:bg-muted/60",
          s.id === selectedShapeId && "bg-muted font-medium",
          off && "opacity-50"
        )}
      >
        <button
          type="button"
          onClick={() => onPickShape?.(s)}
          className="flex min-w-0 flex-1 px-1.5 py-1 pl-2 text-left text-[13px]"
        >
          {s.kind === "area" && (s.room || s.location || s.color) ? (
            <ColorBadge
              name={name || "Area"}
              color={areaColor(s)}
              className="max-w-52"
            />
          ) : name ? (
            <TruncatedText className="block">{name}</TruncatedText>
          ) : (
            <TruncatedText className="block text-muted-foreground">
              {s.kind === "area" ? areaFallbackName(s, cellMm) : "Unnamed"}
            </TruncatedText>
          )}
        </button>
        {eyes && (
          <VisibilityToggle
            vis={{
              shown: !off,
              onChange: (shown) => toggle(key, s.id, shown),
              what: name || (s.kind === "area" ? "area" : "label"),
            }}
          />
        )}
      </div>
    )
  }

  const section = (
    label: string,
    groups: Group[],
    groupKey: "tileTypes" | "roleTypes"
  ) =>
    groups.length > 0 && (
      <ObjectsSection heading={label}>
        {groups.map((g) => (
          <FoldableGroup
            key={g.key}
            name={g.title}
            label={
              <ColorBadge
                name={g.title}
                color={g.color || undefined}
                className="max-w-44"
              />
            }
            count={g.tiles.length}
            visibility={
              eyes
                ? {
                    shown: !isHidden(hidden, groupKey, g.key),
                    onChange: (shown) => toggle(groupKey, g.key, shown),
                    what: g.title,
                  }
                : undefined
            }
            extra={
              <>
                <CheckCountBadge
                  check="down"
                  n={g.tiles.filter((t) => checkOf(t) === "down").length}
                />
                <CheckCountBadge
                  check="degraded"
                  n={g.tiles.filter((t) => checkOf(t) === "degraded").length}
                />
              </>
            }
          >
            {g.tiles.map((t) => {
              const name = tileName(t)
              const off = eyes && tileHidden(t, hidden)
              // A labelled tile hides its linked object's real name - surface
              // it as a muted second line so the row reads "label / device".
              const sub =
                t.linked?.name && t.linked.name !== name ? t.linked.name : null
              return (
                <div
                  key={t.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded pr-1 hover:bg-muted/60",
                    t.id === selectedId && "bg-muted font-medium",
                    off && "opacity-50"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onPick(t)}
                    className="flex min-w-0 flex-1 flex-col px-1.5 py-1 pl-6 text-left text-[13px]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <TileIconGlyph tile={t} />
                      {name ? (
                        <TruncatedText className="block">{name}</TruncatedText>
                      ) : (
                        <span className="text-muted-foreground">Unnamed</span>
                      )}
                    </span>
                    {sub && (
                      <TruncatedText className="block text-[11px] leading-tight font-normal text-muted-foreground">
                        {sub}
                      </TruncatedText>
                    )}
                  </button>
                  <RowCheckBadge check={checkOf(t)} />
                  {eyes && (
                    <VisibilityToggle
                      vis={{
                        shown: !isHidden(hidden, "tiles", t.id),
                        onChange: (shown) => toggle("tiles", t.id, shown),
                        what: name || "tile",
                      }}
                    />
                  )}
                </div>
              )
            })}
          </FoldableGroup>
        ))}
      </ObjectsSection>
    )

  return (
    <ObjectsPanel
      total={total}
      query={q}
      onQueryChange={setQ}
      onSearchEnter={() => {
        if (first) onPick(first)
      }}
      status={status}
      onStatusChange={setStatus}
      statusCounts={statusCounts}
      hiddenCount={hiddenCount(hidden)}
      onShowAll={
        onHiddenChange ? () => onHiddenChange(NO_FLOOR_HIDDEN) : undefined
      }
    >
      {omitRacks && (
        <p className="px-1 pb-2 text-[11px] text-muted-foreground">
          Racks: in the table below
        </p>
      )}
      {unplaced}
      {total + areaRows.length + labelRows.length === 0 ? (
        <ObjectsEmpty filtered={!!q.trim() || !!status} />
      ) : (
        <>
          {section("Placed objects", objectGroups, "roleTypes")}
          {section("Device roles", roleGroups, "roleTypes")}
          {section("Tile types", typeGroups, "tileTypes")}
          {areaRows.length > 0 && (
            <ObjectsSection heading="Rooms and areas">
              {areaRows.map(shapeRow)}
            </ObjectsSection>
          )}
          {labelRows.length > 0 && (
            <ObjectsSection heading="Labels">
              {labelRows.map(shapeRow)}
            </ObjectsSection>
          )}
        </>
      )}
    </ObjectsPanel>
  )
}
