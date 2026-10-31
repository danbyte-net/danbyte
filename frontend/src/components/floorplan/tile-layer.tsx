import { useSyncExternalStore } from "react"
import { ArrowUpDown, Server } from "lucide-react"

import type { FloorPlanLiveState, FloorPlanTile } from "@/lib/api"
import { getLucideIcon } from "@/components/dynamic-icon"

import { tileMarkerCells } from "./cable-draw"
import { CELL, GUTTER, tileIsZone, tileName } from "./canvas-geometry"
import {
  READABLE_FONT_PX,
  clipName,
  growFactor,
  growsReadable,
  nameBox,
  namePriority,
  thinNames,
} from "./readable"
import type { NameCandidate } from "./readable"
import { rackFigures, tileFill, tilePaint, tileRoleIcon } from "./tile-paint"
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
            y={h + 10}
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

/** Camera field-of-view wedge: direction (0° = up, clockwise), angle,
 * distance in cells. Rendered above tiles, ignores pointer events. */
export function FovCone({ tile }: { tile: FloorPlanTile }) {
  const angle = Math.min(360, Math.max(10, tile.fov_deg ?? 90))
  const dist = (tile.fov_distance ?? 3) * CELL
  const dir = tile.fov_direction ?? 0
  // The cone emits from the tile's anchor - a corner or the center
  // (the dice-5 picker in the inspector).
  const ax = tile.fov_anchor.includes("l")
    ? 0
    : tile.fov_anchor.includes("r")
      ? 1
      : 0.5
  const ay = tile.fov_anchor.includes("t")
    ? 0
    : tile.fov_anchor.includes("b")
      ? 1
      : 0.5
  const cx = (tile.x + tile.width * ax) * CELL
  const cy = (tile.y + tile.height * ay) * CELL
  const fill = tileFill(tile)

  // PTZ: the camera can sweep the whole circle - draw a 360° ring instead
  // of a fixed wedge.
  if (tile.fov_ptz) {
    return (
      <circle
        cx={cx}
        cy={cy}
        r={dist}
        fill={fill}
        fillOpacity={0.08}
        stroke={fill}
        strokeOpacity={0.45}
        strokeWidth={1}
        strokeDasharray="4 3"
        pointerEvents="none"
      />
    )
  }

  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180
  const a0 = rad(dir - angle / 2)
  const a1 = rad(dir + angle / 2)
  const x0 = cx + dist * Math.cos(a0)
  const y0 = cy + dist * Math.sin(a0)
  const x1 = cx + dist * Math.cos(a1)
  const y1 = cy + dist * Math.sin(a1)
  const largeArc = angle > 180 ? 1 : 0

  return (
    <path
      d={`M ${cx} ${cy} L ${x0} ${y0} A ${dist} ${dist} 0 ${largeArc} 1 ${x1} ${y1} Z`}
      fill={fill}
      fillOpacity={0.12}
      stroke={fill}
      strokeOpacity={0.45}
      strokeWidth={1}
      strokeDasharray="4 3"
      pointerEvents="none"
    />
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

const NO_HOVER: HoverStore = {
  get: () => null,
  set: () => {},
  subscribe: () => () => {},
}

/**
 * Readable from afar: the names of the tiles grown to READABLE_SYMBOL_PX,
 * under each symbol at READABLE_FONT_PX on screen whatever the zoom, on a
 * halo. Only names in view are laid out, and where two would overlap the
 * lower ranked one hides (`thinNames`); the selected and the hovered tile
 * always show theirs.
 */
export function ReadableNames({
  tiles,
  k,
  tx,
  ty,
  viewW,
  viewH,
  pinned,
  hover = NO_HOVER,
}: {
  /** The tiles drawn, zones left out. */
  tiles: readonly FloorPlanTile[]
  /** The canvas transform: zoom and pan (screen px). */
  k: number
  tx: number
  ty: number
  /** The canvas's size on screen (px); 0 lays out every name. */
  viewW: number
  viewH: number
  /** Tiles whose name always shows - the selection. */
  pinned?: ReadonlySet<string>
  hover?: HoverStore
}) {
  const hovered = useSyncExternalStore(hover.subscribe, hover.get, hover.get)
  const pxPerCell = CELL * k
  const font = READABLE_FONT_PX
  const cands: NameCandidate[] = []
  const placed = new Map<string, { x: number; y: number; text: string }>()
  const margin = 80
  for (const tile of tiles) {
    const name = tileName(tile)
    if (!name || !growsReadable(tile)) continue
    const grow = growFactor(tile.width, tile.height, pxPerCell)
    if (grow <= 1) continue
    const cx = (tile.x + tile.width / 2) * pxPerCell + tx
    const cy = (tile.y + tile.height / 2) * pxPerCell + ty
    if (
      viewW > 0 &&
      (cx < -margin ||
        cy < -margin ||
        cx > viewW + margin ||
        cy > viewH + margin)
    )
      continue
    const top = cy + (tile.height * pxPerCell * grow) / 2 + 2
    const box = nameBox(name, cx, top, font)
    const always = tile.id === hovered || !!pinned?.has(tile.id)
    cands.push({
      id: tile.id,
      ...box,
      priority: always ? Infinity : namePriority(tile),
    })
    placed.set(tile.id, {
      // Back to plan px, inside the pan/zoom group.
      x: (cx - tx) / k,
      y: (top - ty + font) / k,
      text: clipName(name),
    })
  }
  if (!cands.length) return null
  const shown = thinNames(cands)
  const out: React.ReactNode[] = []
  for (const [id, p] of placed) {
    if (!shown.has(id)) continue
    out.push(
      <text
        key={id}
        data-readable-name={id}
        x={p.x}
        y={p.y}
        textAnchor="middle"
        fontSize={font / k}
        fontWeight={500}
        className="fill-foreground stroke-background"
        strokeWidth={3 / k}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {p.text}
      </text>
    )
  }
  return (
    <g data-layer="readable-names" pointerEvents="none">
      {out}
    </g>
  )
}
