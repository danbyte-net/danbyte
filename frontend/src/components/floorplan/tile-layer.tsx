import { ArrowUpDown, Server } from "lucide-react"

import type { FloorPlanLiveState, FloorPlanTile } from "@/lib/api"
import { getLucideIcon } from "@/components/dynamic-icon"
import { tileIcon } from "@/components/object-icon"

import { tileMarkerCells } from "./cable-draw"
import { CELL, GUTTER, tileIsZone, tileName } from "./canvas-geometry"
import type { ClusterFace } from "./icon-layout"
import { HALL_FONT_PX } from "./plan-lod"
import {
  CHECK_COLOR,
  rackFigures,
  tileFill,
  tilePaint,
  tileRoleIcon,
} from "./tile-paint"
import type { ColorBy, RackFigures } from "./tile-paint"

/** Native hover tooltip text: name · type · linked · (rack) used-U/%. */
function tileTooltip(
  tile: FloorPlanTile,
  live?: FloorPlanLiveState["tiles"][string]
): string {
  const parts = [
    tileName(tile) || tile.tile_type?.name || tile.role_type?.name || "Tile",
  ]
  const type = tile.tile_type?.name ?? tile.role_type?.name
  if (type && type !== parts[0]) parts.push(type)
  if (tile.status) parts.push(tile.status)
  if (tile.linked) parts.push(`→ ${tile.linked.kind} ${tile.linked.name}`)
  if (live?.kind === "rack" && live.u_height > 0) {
    parts.push(
      `${live.used_units}/${live.u_height}U (${Math.round(
        (live.used_units / live.u_height) * 100
      )}%)`
    )
  }
  if (live?.kind === "cabinet") {
    const n = (count: number, one: string) =>
      `${count} ${one}${count === 1 ? "" : "s"}`
    parts.push(
      `${n(live.device_count, "device")}, ${n(live.rail_count, "rail")}`
    )
  }
  if (live?.check) parts.push(`check: ${live.check}`)
  return parts.join(" · ")
}

/** Label sizing: fixed 11px + ellipsis, or (labelFit) scaled to FILL the
 * tile - as big as the footprint allows, bounded by width per glyph and by
 * tile height (leaving room for the utilization bar). */
function labelLayout(name: string, w: number, h: number, labelFit: boolean) {
  if (!labelFit) {
    const maxChars = Math.max(3, Math.floor(w / 7))
    return {
      fontSize: 11,
      text: name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name,
    }
  }
  // ~0.62em average glyph width for the system sans.
  const widthFit = (w - 8) / (Math.max(1, name.length) * 0.62)
  return { fontSize: Math.max(5, Math.min(h * 0.55, widthFit)), text: name }
}

export function TileShape({
  tile,
  selected,
  editable,
  labelFit,
  showZoneLabels = true,
  photoOutline = false,
  live,
  colorBy = "type",
  figures,
  highlighted = false,
  dimmed = false,
  grip = true,
  handlePx = 12,
  hideName = false,
  zoneNameGrow = 1,
  onPointerDown,
  onResizeDown,
  onDoubleClick,
  onPointerEnter,
  onPointerLeave,
}: {
  tile: FloorPlanTile
  selected: boolean
  editable: boolean
  labelFit: boolean
  showZoneLabels?: boolean
  /** A photo tile's outline (status, monitoring) when not selected. */
  photoOutline?: boolean
  live?: FloorPlanLiveState["tiles"][string]
  /** What the plan colours its racks by (`tile-paint.ts`). */
  colorBy?: ColorBy
  /** This rack tile's figures; without them a rack reads its live state. */
  figures?: RackFigures
  /** Pointed at from outside the canvas - a rack table row under the
   * pointer. */
  highlighted?: boolean
  /** Left out by the rack table's filter. */
  dimmed?: boolean
  /** The corner resize grip on a selected tile (a free plan has its own
   * handles). */
  grip?: boolean
  /** The grip's side in plan px - the canvas keeps it the size of every
   * other handle on screen. */
  handlePx?: number
  /** Readable from afar: the name is drawn by the names layer instead. */
  hideName?: boolean
  /** A zone's name, grown to stay readable from afar (Readable). */
  zoneNameGrow?: number
  onPointerDown: (e: React.PointerEvent) => void
  onResizeDown: (e: React.PointerEvent) => void
  onDoubleClick: () => void
  /** Hover in/out - fires only on tile boundary crossings, so the popover
   * costs nothing per pointermove (see the note on handleMove). */
  onPointerEnter?: (e: React.PointerEvent) => void
  onPointerLeave?: (e: React.PointerEvent) => void
}) {
  const w = tile.width * CELL
  const h = tile.height * CELL
  const name = tileName(tile)
  const zone = tileIsZone(tile)
  const dashed = tile.status === "planned" || tile.status === "reserved"
  const showLabel = !!name && !hideName

  // Live monitoring: down/degraded overrides the stroke so a rack going red
  // is visible at any zoom - whatever the fill says about its capacity.
  const rackLive = live?.kind === "rack" ? live : null
  const paint = tilePaint({
    tile,
    colorBy,
    rack: figures ?? rackFigures(null, rackLive),
    check: live?.check ?? null,
    selected,
    dimmed,
  })
  const fill = paint.fill
  const cabinetLive = live?.kind === "cabinet" ? live : null
  // The figure along the foot: on a two-cell tile its text sits at the
  // right; a capacity mode writes it on a one-cell tile too, centred. Where
  // the tile is too small for both side by side, the name moves up to make
  // room - never under Type, which keeps the plan's look.
  const figure = paint.figure
  const wide = w >= CELL * 2
  const figureText = figure && (wide || figure.always) ? figure.text : null
  const stacked = !!figureText && (!wide || (!!figure?.always && h < CELL * 2))
  const label = showLabel
    ? stacked
      ? stackedLabel(labelLayout(name, w, h - 14, labelFit), h)
      : labelLayout(name, w, h, labelFit)
    : null
  const labelY = stacked
    ? (h - 14) / 2 + (label?.fontSize ?? 0) / 3
    : h / 2 + (label?.fontSize ?? 0) / 3

  if (zone) {
    const zoneFill = tileFill(tile)
    // Zones: soft area tint under everything, label pinned top-left, no
    // selection handles beyond the outline.
    return (
      <g
        transform={`translate(${tile.x * CELL},${tile.y * CELL})`}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        style={{ cursor: editable ? "move" : "pointer" }}
      >
        <rect
          width={w}
          height={h}
          rx={4}
          fill={zoneFill}
          fillOpacity={0.14}
          stroke={zoneFill}
          strokeOpacity={selected ? 0.9 : 0.35}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray="4 4"
        />
        {showLabel && showZoneLabels && (
          <text
            x={6 * zoneNameGrow}
            y={14 * zoneNameGrow}
            fontSize={10 * zoneNameGrow}
            fill={zoneFill}
            pointerEvents="none"
            fontWeight={500}
            className={zoneNameGrow > 1 ? "stroke-background" : undefined}
            strokeWidth={zoneNameGrow > 1 ? 3 * zoneNameGrow : undefined}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            {name}
          </text>
        )}
        {selected && editable && grip && (
          <ResizeGrip
            x={w}
            y={h}
            size={handlePx}
            onPointerDown={onResizeDown}
          />
        )}
      </g>
    )
  }

  // A device or rack shown as its photo: the picture with its aspect kept,
  // an outline that carries selection and monitoring, the name under it.
  if (tile.display === "photo" && tile.photo) {
    return (
      <g
        transform={`translate(${tile.x * CELL},${tile.y * CELL})`}
        opacity={paint.opacity}
        data-tile={tile.id}
        data-part="photo-tile"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        style={{ cursor: editable ? "move" : "pointer" }}
        role="img"
        aria-label={tileTooltip(tile, live)}
      >
        <image
          href={tile.photo.url}
          width={w}
          height={h}
          preserveAspectRatio="xMidYMid meet"
        />
        {/* The outline: always while selected, else only with Display >
            Photo outlines - a transparent hit area otherwise. */}
        <rect
          data-part="photo-outline"
          width={w}
          height={h}
          rx={2}
          fill="transparent"
          stroke={selected || photoOutline ? paint.stroke : "none"}
          strokeOpacity={selected || paint.alarm ? 1 : 0.35}
          strokeWidth={paint.strokeWidth}
          strokeDasharray={dashed ? "6 3" : undefined}
        />
        {highlighted && (
          <rect
            data-part="highlight"
            x={-2.5}
            y={-2.5}
            width={w + 5}
            height={h + 5}
            rx={4}
            fill="none"
            className="stroke-primary"
            strokeWidth={2.5}
            pointerEvents="none"
          />
        )}
        {showLabel && (
          <text
            x={w / 2}
            y={h + 8.5}
            textAnchor="middle"
            fontSize={9}
            fill="currentColor"
            opacity={0.8}
            pointerEvents="none"
          >
            {name.length > 40 ? `${name.slice(0, 39)}…` : name}
          </text>
        )}
        {selected && editable && grip && (
          <ResizeGrip
            x={w}
            y={h}
            size={handlePx}
            onPointerDown={onResizeDown}
          />
        )}
      </g>
    )
  }
  // A tile with no type of its own wears its object's role icon.
  const RoleIcon = (() => {
    const icon = tileRoleIcon(tile)
    return icon ? getLucideIcon(icon) : null
  })()
  const iconSize = Math.min(14, (h - GUTTER * 2) * 0.32)

  return (
    <g
      transform={`translate(${tile.x * CELL},${tile.y * CELL})`}
      opacity={paint.opacity}
      data-tile={tile.id}
      data-highlighted={highlighted || undefined}
      data-dimmed={dimmed || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ cursor: editable ? "move" : "pointer" }}
      // No <title>: that IS the native browser tooltip, which the rich popover
      // replaces. The same summary stays as the accessible name, so screen
      // readers lose nothing.
      role="img"
      aria-label={tileTooltip(tile, live)}
    >
      {/* The rect sits a gutter inside the cell footprint so adjacent tiles
          get a visible seam instead of touching strokes. Linked tiles fill
          heavier than unlinked planning tiles - same read as the 3D room's
          solid cabinets vs ghost massing - which replaces the old link dot.
          Coloured by a rack measure, the fill is the rack's level. */}
      {/* A linked tile stands on the page's own colour, so it reads as a
          solid block over a map or a photo instead of letting it through. */}
      {tile.linked && (
        <rect
          data-part="base"
          x={GUTTER}
          y={GUTTER}
          width={w - GUTTER * 2}
          height={h - GUTTER * 2}
          rx={5}
          fill="var(--background)"
          pointerEvents="none"
        />
      )}
      {/* Monitoring down or degraded: a soft ring in its colour round the
          tile's own outline, so the alarm reads from afar without a heavy
          stroke on the tile. */}
      {paint.alarm && (
        <rect
          data-part="alarm"
          x={GUTTER - ALARM_RING_PX / 2}
          y={GUTTER - ALARM_RING_PX / 2}
          width={w - GUTTER * 2 + ALARM_RING_PX}
          height={h - GUTTER * 2 + ALARM_RING_PX}
          rx={5 + ALARM_RING_PX / 2}
          fill="none"
          stroke={paint.stroke}
          strokeOpacity={0.3}
          strokeWidth={ALARM_RING_PX}
          pointerEvents="none"
        />
      )}
      <rect
        data-part="fill"
        x={GUTTER}
        y={GUTTER}
        width={w - GUTTER * 2}
        height={h - GUTTER * 2}
        rx={5}
        fill={fill}
        fillOpacity={paint.fillOpacity}
        stroke={paint.stroke}
        strokeOpacity={paint.strokeOpacity}
        strokeWidth={paint.strokeWidth}
        strokeDasharray={dashed ? "6 3" : undefined}
      />
      {/* Pointed at from the rack table: a ring just outside the tile, in
          the accent, so it reads over any fill. */}
      {highlighted && (
        <rect
          data-part="highlight"
          x={GUTTER - 2.5}
          y={GUTTER - 2.5}
          width={w - GUTTER * 2 + 5}
          height={h - GUTTER * 2 + 5}
          rx={7}
          fill="none"
          className="stroke-primary"
          strokeWidth={2.5}
          pointerEvents="none"
        />
      )}
      {/* Facing is the tile's own property (build-in-advance): every
          non-zone tile shows its front edge, linked or not - otherwise the
          bulk facing arrows change unlinked tiles invisibly. */}
      <g transform={`translate(${GUTTER},${GUTTER})`}>
        <FacingEdge
          w={w - GUTTER * 2}
          h={h - GUTTER * 2}
          orientation={tile.orientation}
          color={fill}
        />
      </g>
      {/* Typed tiles stay clean (colour, label, live state); a tile placed
          straight from an object wears that object's role icon. */}
      {RoleIcon && iconSize >= 6 && (
        <RoleIcon
          data-part="role-icon"
          x={GUTTER + 3}
          y={GUTTER + 3}
          width={iconSize}
          height={iconSize}
          color={fill}
          strokeWidth={2.25}
          pointerEvents="none"
          aria-hidden="true"
        />
      )}
      {/* A riser: cables leave the floor through it. */}
      {tile.riser && iconSize >= 6 && (
        <ArrowUpDown
          data-part="riser-icon"
          x={w - GUTTER - 3 - iconSize}
          y={GUTTER + 3}
          width={iconSize}
          height={iconSize}
          color={fill}
          strokeWidth={2.25}
          pointerEvents="none"
          aria-hidden="true"
        />
      )}
      {label && (
        <text
          x={w / 2}
          y={labelY}
          textAnchor="middle"
          fontSize={label.fontSize}
          fontWeight={500}
          fill="currentColor"
          opacity={paint.muted ? 0.6 : 1}
          pointerEvents="none"
        >
          {label.text}
        </text>
      )}
      {figure && (
        // Rack tiles: a thin bar along the bottom edge - space, or the
        // measure the plan is coloured by - and its figure.
        <g pointerEvents="none" data-part="figure">
          <rect
            x={GUTTER + 3}
            y={h - GUTTER - 7}
            width={w - GUTTER * 2 - 6}
            height={4}
            rx={2}
            className="fill-foreground/10"
          />
          {figure.ratio != null && (
            <rect
              x={GUTTER + 3}
              y={h - GUTTER - 7}
              width={Math.max(
                2,
                (w - GUTTER * 2 - 6) * Math.min(1, figure.ratio)
              )}
              height={4}
              rx={2}
              fill={figure.color}
            />
          )}
          {figureText && (
            <text
              x={wide ? w - GUTTER - 4 : w / 2}
              y={h - GUTTER - 10}
              textAnchor={wide ? "end" : "middle"}
              fontSize={8}
              fill="currentColor"
              opacity={figure.always ? 0.85 : 0.7}
              className="num"
            >
              {figureText}
            </text>
          )}
        </g>
      )}
      {cabinetLive && (
        <CabinetCount
          w={w}
          h={h}
          count={cabinetLive.device_count}
          // The resize handle takes the corner on a selected tile.
          inset={selected && editable ? 9 : 0}
        />
      )}
      {selected && editable && grip && (
        <ResizeGrip x={w} y={h} size={handlePx} onPointerDown={onResizeDown} />
      )}
    </g>
  )
}

/** A selected tile's corner resize grip: the editor's handle look (the one
 * areas, walls and doors wear), centred on the corner. */
function ResizeGrip({
  x,
  y,
  size,
  onPointerDown,
}: {
  x: number
  y: number
  size: number
  onPointerDown: (e: React.PointerEvent) => void
}) {
  return (
    <rect
      data-handle="se"
      x={x - size / 2}
      y={y - size / 2}
      width={size}
      height={size}
      rx={size / 6}
      className="fill-background stroke-primary"
      strokeWidth={size / 6}
      style={{ cursor: "nwse-resize" }}
      onPointerDown={onPointerDown}
    />
  )
}

/** A one-cell tile that also carries its figure: the name gets the room
 * above it, no larger than the cell can hold beside the figure. */
function stackedLabel(
  label: { fontSize: number; text: string },
  h: number
): { fontSize: number; text: string } {
  return { ...label, fontSize: Math.min(label.fontSize, (h - 14) * 0.45) }
}

/** A cabinet tile's device count, small in its bottom-right corner: the
 * devices icon and the number, as a rack tile reads its use there. */
function CabinetCount({
  w,
  h,
  count,
  inset = 0,
}: {
  w: number
  h: number
  count: number
  /** Extra room at the right, px - kept clear of the resize handle. */
  inset?: number
}) {
  const text = String(count)
  const right = w - GUTTER - 4 - inset
  const base = h - GUTTER - 4
  // ~0.6em per digit at 8px, and a pixel between the glyph and the number.
  const iconX = right - text.length * 4.8 - 1 - 8
  return (
    <g
      data-part="device-count"
      pointerEvents="none"
      opacity={0.75}
      aria-hidden="true"
    >
      <Server x={iconX} y={base - 7} width={8} height={8} strokeWidth={2.25} />
      <text
        x={right}
        y={base}
        textAnchor="end"
        fontSize={8}
        fill="currentColor"
        className="num"
      >
        {text}
      </text>
    </g>
  )
}

/**
 * A rack tile's facing indicator: a thin accent bar hugging the INSIDE of the
 * edge the cabinet's FRONT (door) points at - a door threshold on an
 * architectural plan. Inside the rect because adjacent tiles share edges: the
 * old outside placement bled straight into the neighbouring cell. It renders
 * before the utilization bar/label, so those draw over it where they meet.
 * Orientation matches the 3D room: 0 = up (north), 90 = right, 180 = down,
 * 270 = left.
 */
function FacingEdge({
  w,
  h,
  orientation,
  color,
}: {
  w: number
  h: number
  orientation: number
  color: string
}) {
  const t = 3 // bar thickness
  const edge = 1.5 // sits just inside the tile's stroke
  const inset = 7 // corner clearance (keeps the rounded corners clean)
  const bar =
    orientation === 90
      ? { x: w - edge - t, y: inset, width: t, height: h - inset * 2 }
      : orientation === 180
        ? { x: inset, y: h - edge - t, width: w - inset * 2, height: t }
        : orientation === 270
          ? { x: edge, y: inset, width: t, height: h - inset * 2 }
          : { x: inset, y: edge, width: w - inset * 2, height: t }
  return (
    <rect {...bar} rx={t / 2} fill={color} opacity={0.9} pointerEvents="none" />
  )
}

/** A tile linked to a device, a rack or a cabinet. */
export function tileLinksObject(tile: FloorPlanTile): boolean {
  const kind = tile.linked?.kind
  return kind === "device" || kind === "rack" || kind === "cabinet"
}

/**
 * From afar: each placed device, rack or cabinet whose tile would shrink
 * below MIN_TILE_PX on screen draws as a marker that size in its colour,
 * centred on the tile - the tile's own geometry untouched. A marker takes
 * the tile's pointer (select, hover, drag).
 */
export function TileMarkers({
  tiles,
  k,
  interactive,
  isLocked,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
}: {
  tiles: readonly FloorPlanTile[]
  /** The canvas zoom: screen px per plan px. */
  k: number
  interactive: boolean
  isLocked: (id: string) => boolean
  onPointerDown: (tile: FloorPlanTile, e: React.PointerEvent) => void
  onPointerEnter?: (tile: FloorPlanTile, e: React.PointerEvent) => void
  onPointerLeave?: () => void
}) {
  const pxPerCell = CELL * k
  const marks: React.ReactNode[] = []
  for (const tile of tiles) {
    if (!tileLinksObject(tile) || tileIsZone(tile)) continue
    const side = tileMarkerCells(tile.width, tile.height, pxPerCell)
    if (side == null) continue
    const s = side * CELL
    const cx = (tile.x + tile.width / 2) * CELL
    const cy = (tile.y + tile.height / 2) * CELL
    const live = interactive && !isLocked(tile.id)
    marks.push(
      <rect
        key={tile.id}
        data-tile-marker={tile.id}
        x={cx - s / 2}
        y={cy - s / 2}
        width={s}
        height={s}
        rx={s * 0.2}
        fill={tileFill(tile)}
        stroke="var(--background)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        pointerEvents={live ? undefined : "none"}
        onPointerDown={live ? (e) => onPointerDown(tile, e) : undefined}
        onPointerEnter={live ? (e) => onPointerEnter?.(tile, e) : undefined}
        onPointerLeave={live ? onPointerLeave : undefined}
      />
    )
  }
  return marks.length ? <g data-layer="tile-markers">{marks}</g> : null
}

/** The tile under the pointer, for the names layer - kept out of React
 * state so a hover re-renders the names alone, not the canvas. */
export interface HoverStore {
  get: () => string | null
  set: (id: string | null) => void
  subscribe: (fn: () => void) => () => void
}

export function createHoverStore(): HoverStore {
  let id: string | null = null
  const subs = new Set<() => void>()
  return {
    get: () => id,
    set: (next) => {
      if (next === id) return
      id = next
      for (const fn of subs) fn()
    },
    subscribe: (fn) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}

/** The soft ring round an alarming tile, plan px. */
const ALARM_RING_PX = 5

/**
 * A tile drawn as its symbol: a rounded box in its colour at the drawn
 * size (`box`, cells) with its icon in white (object-icon.ts: the device,
 * its type, the tile's type, the role, the kind's default), and its
 * outline for selection and monitoring. Readable draws it for a tile too
 * thin or a photo too small to read; Icons when zoomed out draws it, a
 * square, for a device, rack or cabinet too small on screen. Back to the
 * tile itself once it is big enough.
 */
export function ReadableSymbol({
  tile,
  box,
  k,
  selected,
  live,
  colorBy = "type",
  figures,
  iconTile = false,
  highlighted = false,
  rotation = 0,
  onPointerDown,
  onDoubleClick,
  onPointerEnter,
  onPointerLeave,
}: {
  tile: FloorPlanTile
  box: { x: number; y: number; w: number; h: number }
  /** Degrees the symbol lies turned about its centre - a free tile's turn
   * past its quarter turn, so a slender row does not stand upright. Its
   * icon stays upright. */
  rotation?: number
  /** The canvas zoom: screen px per plan px. */
  k: number
  selected: boolean
  live?: FloorPlanLiveState["tiles"][string]
  colorBy?: ColorBy
  figures?: RackFigures
  /** Drawn as its icon from afar (Display > Icons when zoomed out). */
  iconTile?: boolean
  /** Pointed at from outside the canvas - a rack table row. */
  highlighted?: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onDoubleClick: () => void
  onPointerEnter?: (e: React.PointerEvent) => void
  onPointerLeave?: (e: React.PointerEvent) => void
}) {
  const rackLive = live?.kind === "rack" ? live : null
  const paint = tilePaint({
    tile,
    colorBy,
    rack: figures ?? rackFigures(null, rackLive),
    check: live?.check ?? null,
    selected,
  })
  const x = box.x * CELL
  const y = box.y * CELL
  const w = box.w * CELL
  const h = box.h * CELL
  const iconName = tileIcon(tile)
  const Icon = iconName ? getLucideIcon(iconName) : null
  // An icon tile is a square: the icon a little smaller, so it reads.
  const icon = Math.min(w, h) * (iconTile ? 0.6 : 0.7)
  const turn = rotation
    ? `rotate(${rotation},${x + w / 2},${y + h / 2})`
    : undefined
  return (
    <g
      data-tile={tile.id}
      data-part="symbol"
      data-icon-tile={iconTile || undefined}
      data-highlighted={highlighted || undefined}
      // Fades in as it takes the tile's place, so the swap reads as one.
      className={iconTile ? "animate-in duration-150 fade-in" : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ cursor: "pointer" }}
      role="img"
      aria-label={tileTooltip(tile, live)}
      opacity={paint.opacity}
    >
      {/* Alarming: a soft ring in the alarm's colour outside the symbol,
          as on a full tile. */}
      {paint.alarm && (
        <rect
          data-part="alarm"
          transform={turn}
          x={x - 3 / k}
          y={y - 3 / k}
          width={w + 6 / k}
          height={h + 6 / k}
          rx={Math.min(w, h) * 0.2 + 3 / k}
          fill="none"
          stroke={paint.stroke}
          strokeOpacity={0.35}
          strokeWidth={4 / k}
          pointerEvents="none"
        />
      )}
      <rect
        transform={turn}
        x={x}
        y={y}
        width={w}
        height={h}
        rx={Math.min(w, h) * 0.2}
        fill={tileFill(tile)}
        fillOpacity={0.9}
        // A hairline of the page round it, so the symbol stands off a map
        // or a busy floor; the alarm or selection colour when it has one.
        stroke={paint.alarm || selected ? paint.stroke : "var(--background)"}
        strokeWidth={(selected || paint.alarm ? 2 : 1.25) / k}
      />
      {/* Pointed at from outside the canvas (a rack table row): the same
          accent ring a full tile wears. */}
      {highlighted && (
        <rect
          data-part="highlight"
          transform={turn}
          x={x - 2.5 / k}
          y={y - 2.5 / k}
          width={w + 5 / k}
          height={h + 5 / k}
          rx={Math.min(w, h) * 0.2 + 2.5 / k}
          fill="none"
          className="stroke-primary"
          strokeWidth={2.5 / k}
          pointerEvents="none"
        />
      )}
      {Icon && (
        <Icon
          data-part="symbol-icon"
          x={x + w / 2 - icon / 2}
          y={y + h / 2 - icon / 2}
          width={icon}
          height={icon}
          color="#ffffff"
          strokeWidth={2.25}
          pointerEvents="none"
          aria-hidden="true"
        />
      )}
    </g>
  )
}

/**
 * Icons that would overlap folded into one (icon-layout.ts): a square in
 * the members' shared colour with their shared icon - the stack when they
 * differ - the count in a badge on its corner, and the worst member's
 * monitoring state as its outline and ring. A click zooms to the members.
 */
export function ClusterTile({
  id,
  box,
  k,
  face,
  onActivate,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string
  box: { x: number; y: number; w: number; h: number }
  /** The canvas zoom: screen px per plan px. */
  k: number
  face: ClusterFace
  onActivate: () => void
  onPointerEnter?: (e: React.PointerEvent) => void
  onPointerLeave?: (e: React.PointerEvent) => void
}) {
  const x = box.x * CELL
  const y = box.y * CELL
  const w = box.w * CELL
  const h = box.h * CELL
  const r = Math.min(w, h) * 0.2
  const alarm = face.check ? CHECK_COLOR[face.check] : undefined
  const Icon = face.icon ? getLucideIcon(face.icon) : null
  const icon = Math.min(w, h) * 0.55
  // The count: a squarish badge over the top right corner.
  const text = String(face.count)
  const bh = 14 / k
  const bw = (text.length * 6.6 + 8) / k
  return (
    <g
      data-icon-cluster={id}
      className="animate-in duration-150 fade-in"
      role="button"
      aria-label={`${face.name}, ${face.count} objects`}
      tabIndex={0}
      style={{ cursor: "zoom-in", outline: "none" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.stopPropagation()
        onActivate()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onActivate()
        }
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {alarm && (
        <rect
          data-part="alarm"
          x={x - 3 / k}
          y={y - 3 / k}
          width={w + 6 / k}
          height={h + 6 / k}
          rx={r + 3 / k}
          fill="none"
          stroke={alarm}
          strokeOpacity={0.35}
          strokeWidth={4 / k}
          pointerEvents="none"
        />
      )}
      {/* A second square peeking out behind: a stack, not one object. */}
      <rect
        x={x + 3 / k}
        y={y - 3 / k}
        width={w}
        height={h}
        rx={r}
        fill={face.fill}
        fillOpacity={0.45}
        stroke="var(--background)"
        strokeWidth={1.25 / k}
      />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={r}
        fill={face.fill}
        fillOpacity={0.95}
        stroke={alarm ?? "var(--background)"}
        strokeWidth={(alarm ? 2 : 1.25) / k}
      />
      {Icon && (
        <Icon
          data-part="cluster-icon"
          x={x + w / 2 - icon / 2}
          y={y + h / 2 - icon / 2}
          width={icon}
          height={icon}
          color="#ffffff"
          strokeWidth={2.25}
          pointerEvents="none"
          aria-hidden="true"
        />
      )}
      <g data-part="cluster-count" pointerEvents="none">
        <rect
          x={x + w - bw * 0.6}
          y={y - bh * 0.45}
          width={bw}
          height={bh}
          rx={4 / k}
          fill="var(--foreground)"
          stroke="var(--background)"
          strokeWidth={1 / k}
        />
        <text
          x={x + w - bw * 0.6 + bw / 2}
          y={y - bh * 0.45 + bh / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={10 / k}
          fontWeight={600}
          fill="var(--background)"
        >
          {text}
        </text>
      </g>
    </g>
  )
}

/** What a symbol (a row, a room's summary) does when pointed at: as a
 * cluster - a click zooms in, hovering lists its members. */
interface SymbolProps {
  id: string
  k: number
  face: ClusterFace
  onActivate: () => void
  onPointerEnter?: (e: React.PointerEvent) => void
  onPointerLeave?: (e: React.PointerEvent) => void
}

function symbolHandlers({
  onActivate,
  onPointerEnter,
  onPointerLeave,
}: SymbolProps) {
  return {
    role: "button",
    tabIndex: 0,
    style: { cursor: "zoom-in", outline: "none" },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onActivate()
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        onActivate()
      }
    },
    onPointerEnter,
    onPointerLeave,
  } as const
}

/** A row of icons from afar (plan-lod.ts): one bar along its line, the
 * row's length and at least its depth thick, in its racks' colour (else
 * zinc), a seam between racks while they are wide enough to show. Its
 * name is the label pass's, along it. */
export function RowSymbolTile(
  props: SymbolProps & {
    /** Its middle (cells). */
    at: readonly [number, number]
    row: { dir: readonly [number, number]; length: number }
    /** Its thickness (cells). */
    thick: number
  }
) {
  const { id, k, face, at, row, thick } = props
  const l = row.length * CELL
  const t = thick * CELL
  const angle = (Math.atan2(row.dir[1], row.dir[0]) * 180) / Math.PI
  const alarm = face.check ? CHECK_COLOR[face.check] : undefined
  const step = l / Math.max(1, face.count)
  const seams = step * k >= 5 ? face.count - 1 : 0
  return (
    <g
      data-row-symbol={id}
      className="animate-in duration-150 fade-in"
      aria-label={`${face.name}, ${face.count} objects`}
      transform={`translate(${at[0] * CELL},${at[1] * CELL}) rotate(${angle})`}
      {...symbolHandlers(props)}
    >
      {alarm && (
        <rect
          data-part="alarm"
          x={-l / 2 - 3 / k}
          y={-t / 2 - 3 / k}
          width={l + 6 / k}
          height={t + 6 / k}
          rx={Math.min(t / 2, 3 / k) + 3 / k}
          fill="none"
          stroke={alarm}
          strokeOpacity={0.35}
          strokeWidth={4 / k}
          pointerEvents="none"
        />
      )}
      <rect
        data-part="bar"
        x={-l / 2}
        y={-t / 2}
        width={l}
        height={t}
        rx={Math.min(t / 2, 3 / k)}
        fill={face.fill}
        fillOpacity={0.9}
        stroke={alarm ?? "var(--background)"}
        strokeWidth={(alarm ? 2 : 1.25) / k}
      />
      {seams > 0 && (
        <path
          data-part="seams"
          d={Array.from({ length: seams }, (_, i) => {
            const x = -l / 2 + step * (i + 1)
            return `M${x},${-t / 2}V${t / 2}`
          }).join("")}
          stroke="var(--background)"
          strokeOpacity={0.55}
          strokeWidth={1 / k}
          pointerEvents="none"
        />
      )}
    </g>
  )
}

/** A room's rows folded into one plate on the room (plan-lod.ts): the
 * racks' icon in their colour, then "Data Hall 1 · 120 racks". */
export function HallSymbolTile(
  props: SymbolProps & { box: { x: number; y: number; w: number; h: number } }
) {
  const { id, k, face, box } = props
  const x = box.x * CELL
  const y = box.y * CELL
  const w = box.w * CELL
  const h = box.h * CELL
  const pad = 3 / k
  const sq = h - pad * 2
  const alarm = face.check ? CHECK_COLOR[face.check] : undefined
  const Icon = face.icon ? getLucideIcon(face.icon) : null
  return (
    <g
      data-hall-symbol={id}
      className="animate-in duration-150 fade-in"
      aria-label={face.name}
      {...symbolHandlers(props)}
    >
      <rect
        data-part="plate"
        x={x}
        y={y}
        width={w}
        height={h}
        rx={4 / k}
        fill="var(--popover)"
        stroke={alarm ?? "var(--border)"}
        strokeWidth={(alarm ? 2 : 1) / k}
      />
      <rect
        x={x + pad}
        y={y + pad}
        width={sq}
        height={sq}
        rx={3 / k}
        fill={face.fill}
      />
      {Icon && (
        <Icon
          x={x + pad + sq * 0.2}
          y={y + pad + sq * 0.2}
          width={sq * 0.6}
          height={sq * 0.6}
          color="#ffffff"
          strokeWidth={2.25}
          pointerEvents="none"
          aria-hidden="true"
        />
      )}
      <text
        x={x + pad * 2 + sq + 2 / k}
        y={y + h / 2}
        dominantBaseline="central"
        fontSize={HALL_FONT_PX / k}
        fontWeight={600}
        fill="var(--popover-foreground)"
        pointerEvents="none"
      >
        {face.name}
      </text>
    </g>
  )
}

/** Where a spread icon really is: a thin leader from its drawn centre
 * (cells) back to its true centre, and a dot there. */
export function IconLeader({
  from,
  to,
  k,
}: {
  from: readonly [number, number]
  to: readonly [number, number]
  k: number
}) {
  return (
    <g
      data-icon-leader=""
      pointerEvents="none"
      className="animate-in duration-200 fade-in"
    >
      <line
        x1={from[0] * CELL}
        y1={from[1] * CELL}
        x2={to[0] * CELL}
        y2={to[1] * CELL}
        className="stroke-muted-foreground"
        strokeOpacity={0.7}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={to[0] * CELL}
        cy={to[1] * CELL}
        r={2.5 / k}
        className="fill-muted-foreground"
        stroke="var(--background)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  )
}
