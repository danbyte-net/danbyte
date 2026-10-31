import { Link2 } from "lucide-react"

import { getLucideIcon } from "@/components/dynamic-icon"

import { CELL } from "./canvas-geometry"
import {
  HANDLES,
  PATTERN_GAP,
  PATTERN_STROKE,
  labelColor,
  areaColor,
  areaIcon,
  areaLabelColor,
  areaName,
  areaNameHalo,
  areaPattern,
  boxCenter,
  handlePoint,
  labelBox,
  labelFontCells,
  labelPlate,
  patternRuns,
  polygonCentroid,
  rotateHandlePoint,
} from "./shapes"
import type { AreaShape, Box, Handle, LabelShape, Pt } from "./shapes"
import type { GestureTarget, ShapeGestures } from "./use-shape-gestures"

// The areas and labels on the 2D plan, their selection handles, and what a
// drawing tool shows while it draws. World pixels (CELL per cell), inside
// the canvas's pan/zoom group.

const px = (v: number) => v * CELL

/** The name's size, and the icon's before it (world px). */
const NAME_PX = 12
const ICON_PX = 12
const ICON_GAP = 4
/** ~Average glyph width of the name's semibold sans, per em. */
const NAME_EM = 0.6

/** An area type's pattern: its strokes over the fill, clipped to the
 * area's own outline (`clip`: a rect or polygon in world px). */
function PatternStrokes({
  id,
  area,
  color,
  clip,
  box,
  zoom,
}: {
  id: string
  area: AreaShape
  color: string
  clip: React.ReactNode
  box: { x: number; y: number; w: number; h: number }
  /** The canvas zoom: the lines keep their spacing and width on screen,
   * so a hatch stays readable zoomed out. */
  zoom: number
}) {
  const runs = patternRuns(areaPattern(area), box.x, box.y, box.w, box.h, {
    gap: PATTERN_GAP / zoom,
  })
  if (!runs.length) return null
  return (
    <>
      <clipPath id={id}>{clip}</clipPath>
      <g
        clipPath={`url(#${id})`}
        data-pattern={areaPattern(area)}
        stroke={color}
        strokeOpacity={PATTERN_STROKE.opacity}
        strokeWidth={PATTERN_STROKE.width / zoom}
        pointerEvents="none"
      >
        {runs.map((run, r) => (
          <g key={r} strokeDasharray={run.dash}>
            {run.lines.map(([x1, y1, x2, y2], i) => (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))}
          </g>
        ))}
      </g>
    </>
  )
}

/** An area's name with its type's icon before it: from (x, y) in its top
 * left (`start`, y the baseline), or centred on (x, y) (`middle`, y the
 * middle). A patterned area's name reads over its lines through a halo of
 * the background. */
function AreaName({
  area,
  name,
  x,
  y,
  anchor,
  ink,
}: {
  area: AreaShape
  name: string
  x: number
  y: number
  anchor: "start" | "middle"
  ink: string
}) {
  const icon = areaIcon(area)
  const Icon = icon ? getLucideIcon(icon) : null
  const shift = Icon ? ICON_PX + ICON_GAP : 0
  const textW = name.length * NAME_PX * NAME_EM
  // The text's anchor point, and the icon's top left before the text.
  const tx = anchor === "middle" ? x + shift / 2 : x + shift
  const ix = anchor === "middle" ? x - (shift + textW) / 2 : x
  const mid = anchor === "middle" ? y : y - NAME_PX * 0.35
  const halo = areaNameHalo(area)
  return (
    <g pointerEvents="none" data-part="area-name">
      {Icon && (
        <Icon
          data-part="area-icon"
          x={ix}
          y={mid - ICON_PX / 2}
          width={ICON_PX}
          height={ICON_PX}
          color={ink}
          strokeWidth={2.25}
        />
      )}
      <text
        x={tx}
        y={y}
        textAnchor={anchor === "middle" ? "middle" : undefined}
        dominantBaseline={anchor === "middle" ? "middle" : undefined}
        fontSize={NAME_PX}
        fontWeight={600}
        fill={ink}
        className={halo ? "stroke-background" : undefined}
        strokeWidth={halo ? 3 : undefined}
        strokeLinejoin={halo ? "round" : undefined}
        paintOrder={halo ? "stroke" : undefined}
      >
        {name}
      </text>
    </g>
  )
}

/** The link mark of an area or label that opens a plan: a small Lucide
 * link icon at (x, y), its top left (world px). */
const LINK_PX = 12
function OpensMark({ x, y, ink }: { x: number; y: number; ink: string }) {
  return (
    <Link2
      data-part="opens-mark"
      x={x}
      y={y}
      width={LINK_PX}
      height={LINK_PX}
      color={ink}
      strokeWidth={2.25}
      pointerEvents="none"
    />
  )
}

/** An area: a tinted rectangle (turned about its centre) or polygon with
 * its name in its top left (a polygon: at its middle), its type's pattern
 * over the tint and its type's icon before the name. */
export function AreaShapeView({
  area,
  selected,
  interactive,
  onPointerDown,
  onEdgeDoubleClick,
  zoom = 1,
}: {
  area: AreaShape
  selected: boolean
  /** The canvas zoom, for strokes that keep their screen size. */
  zoom?: number
  /** Takes the pointer (Edit with Select, or View). */
  interactive: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  onEdgeDoubleClick?: (seg: number, e: React.MouseEvent) => void
}) {
  const color = areaColor(area)
  const ink = areaLabelColor(area)
  const name = area.show_name ? areaName(area) : ""
  const dash = area.border === "dashed" ? "8 5" : undefined
  const strokeOpacity = area.border === "none" ? 0 : selected ? 0.95 : 0.6
  const clipId = `area-pattern-${area.id}`
  const common = {
    fill: color,
    fillOpacity: area.fill_opacity / 100,
    stroke: color,
    strokeOpacity,
    strokeWidth: (selected ? 2.5 : 1.5) / zoom,
    strokeDasharray: dash,
  }
  const style: React.CSSProperties = {
    cursor: interactive ? "pointer" : undefined,
    pointerEvents: interactive ? "auto" : "none",
  }
  if (area.shape === "polygon") {
    const pts = area.points
    if (pts.length < 3) return null
    const [cx, cy] = polygonCentroid(pts)
    const outline = pts.map(([x, y]) => `${px(x)},${px(y)}`).join(" ")
    const xs = pts.map((p) => px(p[0]))
    const ys = pts.map((p) => px(p[1]))
    const bx = Math.min(...xs)
    const by = Math.min(...ys)
    return (
      <g
        data-area={area.id}
        style={style}
        onPointerDown={onPointerDown}
        aria-label={name || "Area"}
      >
        <polygon points={outline} strokeLinejoin="round" {...common} />
        <PatternStrokes
          id={clipId}
          area={area}
          color={color}
          zoom={zoom}
          clip={<polygon points={outline} />}
          box={{
            x: bx,
            y: by,
            w: Math.max(...xs) - bx,
            h: Math.max(...ys) - by,
          }}
        />
        {onEdgeDoubleClick &&
          pts.map((p, i) => {
            const q = pts[(i + 1) % pts.length]
            return (
              <line
                key={i}
                x1={px(p[0])}
                y1={px(p[1])}
                x2={px(q[0])}
                y2={px(q[1])}
                stroke="transparent"
                strokeWidth={10}
                onDoubleClick={(e) => onEdgeDoubleClick(i, e)}
              />
            )
          })}
        {name && (
          <AreaName
            area={area}
            name={name}
            x={px(cx)}
            y={px(cy)}
            anchor="middle"
            ink={ink}
          />
        )}
        {(area.opens || area.opens_hidden) && (
          <OpensMark
            x={px(cx) - LINK_PX / 2}
            y={px(cy) + (name ? NAME_PX : -LINK_PX / 2)}
            ink={ink}
          />
        )}
      </g>
    )
  }
  const w = px(area.width)
  const h = px(area.height)
  const [cx, cy] = boxCenter(area)
  return (
    <g
      data-area={area.id}
      style={style}
      onPointerDown={onPointerDown}
      transform={
        area.rotation
          ? `rotate(${area.rotation},${px(cx)},${px(cy)})`
          : undefined
      }
      aria-label={name || "Area"}
    >
      <rect
        x={px(area.x)}
        y={px(area.y)}
        width={w}
        height={h}
        rx={3}
        {...common}
      />
      <PatternStrokes
        id={clipId}
        area={area}
        color={color}
        zoom={zoom}
        clip={
          <rect x={px(area.x)} y={px(area.y)} width={w} height={h} rx={3} />
        }
        box={{ x: px(area.x), y: px(area.y), w, h }}
      />
      {name && w > 30 && h > 18 && (
        <AreaName
          area={area}
          name={name}
          x={px(area.x) + 6}
          y={px(area.y) + 15}
          anchor="start"
          ink={ink}
        />
      )}
      {(area.opens || area.opens_hidden) && w > LINK_PX + 8 && (
        <OpensMark
          x={px(area.x) + w - LINK_PX - 4}
          y={px(area.y) + 4}
          ink={ink}
        />
      )}
    </g>
  )
}

/** A label: its text at its real size, optionally on a plate. */
export function LabelShapeView({
  label,
  cellMm,
  interactive,
  viewing = false,
  onPointerDown,
}: {
  label: LabelShape
  cellMm: number
  interactive: boolean
  /** View: a click opens its link (a pointer, not a move cursor). */
  viewing?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
}) {
  const box = labelBox(label, cellMm)
  const [cx, cy] = boxCenter(box)
  const size = px(labelFontCells(label.font_mm, cellMm))
  const lines = label.text.split("\n")
  const anchor =
    label.align === "center"
      ? "middle"
      : label.align === "right"
        ? "end"
        : "start"
  const tx =
    label.align === "center"
      ? px(box.x + box.width / 2)
      : label.align === "right"
        ? px(box.x + box.width) - size * 0.3
        : px(box.x) + size * 0.3
  const color = labelColor(label.color)
  const plate = labelPlate(label)
  return (
    <g
      data-label={label.id}
      transform={
        label.rotation
          ? `rotate(${label.rotation},${px(cx)},${px(cy)})`
          : undefined
      }
      onPointerDown={onPointerDown}
      style={{
        cursor: interactive ? (viewing ? "pointer" : "move") : undefined,
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      {/* The hit area, and the plate when it has one. */}
      <rect
        x={px(box.x)}
        y={px(box.y)}
        width={px(box.width)}
        height={px(box.height)}
        rx={Math.min(6, size * 0.2)}
        className={
          label.plate
            ? plate.fill
              ? "stroke-border"
              : "fill-background stroke-border"
            : undefined
        }
        fill={label.plate ? (plate.fill ?? undefined) : "transparent"}
        data-plate={plate.fill ?? undefined}
        strokeWidth={label.plate ? 1 : 0}
      />
      <text
        className={plate.ink ? undefined : color.className}
        fill={plate.ink ?? undefined}
        fontSize={size}
        fontWeight={label.weight === "bold" ? 700 : 400}
        textAnchor={anchor}
        pointerEvents="none"
      >
        {lines.map((line, i) => (
          <tspan
            key={i}
            x={tx}
            y={px(box.y) + size * 0.15 + size * (i * 1.25 + 1)}
          >
            {line || " "}
          </tspan>
        ))}
      </text>
      {(label.opens || label.opens_hidden) && (
        <OpensMark
          x={px(box.x + box.width) + 2}
          y={px(box.y)}
          ink={plate.ink ?? color.paper}
        />
      )}
    </g>
  )
}

/** Every handle on the plan is this many screen pixels across - areas,
 * labels, free tiles, tile grips, walls, trays, raised floors and doors. */
export const HANDLE_PX = 9

/** The handles of a selected box: eight squares to resize, a circle above
 * the top edge to turn it. Their screen size holds at any zoom. */
export function BoxHandles({
  box,
  target,
  zoom,
  gestures,
  handles = HANDLES,
}: {
  box: Box
  target: GestureTarget
  zoom: number
  gestures: ShapeGestures
  handles?: readonly Handle[]
}) {
  const s = HANDLE_PX / zoom
  const gap = 22 / zoom / CELL
  const [rx, ry] = rotateHandlePoint(box, gap)
  const [tx, ty] = handlePoint(box, "n")
  const cursor = (h: Handle) =>
    h === "n" || h === "s"
      ? "ns-resize"
      : h === "e" || h === "w"
        ? "ew-resize"
        : h === "nw" || h === "se"
          ? "nwse-resize"
          : "nesw-resize"
  return (
    <g data-handles="">
      <line
        x1={px(tx)}
        y1={px(ty)}
        x2={px(rx)}
        y2={px(ry)}
        className="stroke-primary"
        strokeWidth={1 / zoom}
        pointerEvents="none"
      />
      {handles.map((h) => {
        const [hx, hy] = handlePoint(box, h)
        return (
          <rect
            key={h}
            data-handle={h}
            x={px(hx) - s / 2}
            y={px(hy) - s / 2}
            width={s}
            height={s}
            rx={1.5 / zoom}
            className="fill-background stroke-primary"
            strokeWidth={1.5 / zoom}
            transform={
              box.rotation
                ? `rotate(${box.rotation},${px(hx)},${px(hy)})`
                : undefined
            }
            style={{ cursor: cursor(h) }}
            onPointerDown={(e) => gestures.handleDown(target, h, e)}
          />
        )
      })}
      <circle
        data-handle="rotate"
        cx={px(rx)}
        cy={px(ry)}
        r={s / 1.6}
        className="fill-background stroke-primary"
        strokeWidth={1.5 / zoom}
        style={{ cursor: "grab" }}
        onPointerDown={(e) => gestures.rotateDown(target, e)}
      />
    </g>
  )
}

/** A selected polygon's points, each a handle to drag. */
export function VertexHandles({
  area,
  zoom,
  gestures,
  onVertexMenu,
}: {
  area: AreaShape
  zoom: number
  gestures: ShapeGestures
  onVertexMenu?: (index: number, e: React.MouseEvent) => void
}) {
  const s = HANDLE_PX / zoom
  return (
    <g data-handles="">
      {area.points.map(([x, y], i) => (
        <rect
          key={i}
          data-vertex={i}
          x={px(x) - s / 2}
          y={px(y) - s / 2}
          width={s}
          height={s}
          rx={s / 2}
          className="fill-background stroke-primary"
          strokeWidth={1.5 / zoom}
          style={{ cursor: "move" }}
          onPointerDown={(e) => gestures.vertexDown(area.id, i, e)}
          onContextMenu={(e) => onVertexMenu?.(i, e)}
        />
      ))}
    </g>
  )
}

/** What a drawing tool shows while it draws, and the snap guides. */
export function DrawPreview({
  gestures,
  width,
  height,
  zoom,
}: {
  gestures: ShapeGestures
  /** The plan in world pixels - the guides run across it. */
  width: number
  height: number
  zoom: number
}) {
  const { rectDraft, poly, cursor, guides } = gestures
  const pts: Pt[] = poly ? (cursor ? [...poly, cursor] : poly) : []
  return (
    <g pointerEvents="none">
      {rectDraft && (
        <rect
          x={px(Math.min(rectDraft.a[0], rectDraft.b[0]))}
          y={px(Math.min(rectDraft.a[1], rectDraft.b[1]))}
          width={px(Math.abs(rectDraft.b[0] - rectDraft.a[0]))}
          height={px(Math.abs(rectDraft.b[1] - rectDraft.a[1]))}
          className="fill-primary/10 stroke-primary"
          strokeWidth={1.5 / zoom}
          strokeDasharray={`${6 / zoom} ${3 / zoom}`}
        />
      )}
      {pts.length > 0 && (
        <>
          <polyline
            points={pts.map(([x, y]) => `${px(x)},${px(y)}`).join(" ")}
            fill="none"
            className="stroke-primary"
            strokeWidth={1.5 / zoom}
            strokeDasharray={`${6 / zoom} ${3 / zoom}`}
          />
          {poly!.map(([x, y], i) => (
            <circle
              key={i}
              cx={px(x)}
              cy={px(y)}
              r={(i === 0 ? 5 : 3) / zoom}
              className="fill-background stroke-primary"
              strokeWidth={1.5 / zoom}
            />
          ))}
        </>
      )}
      {guides?.x != null && (
        <line
          x1={px(guides.x)}
          y1={0}
          x2={px(guides.x)}
          y2={height}
          className="stroke-primary/60"
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${3 / zoom}`}
        />
      )}
      {guides?.y != null && (
        <line
          x1={0}
          y1={px(guides.y)}
          x2={width}
          y2={px(guides.y)}
          className="stroke-primary/60"
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${3 / zoom}`}
        />
      )}
    </g>
  )
}
