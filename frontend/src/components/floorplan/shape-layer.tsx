import { Link2 } from "lucide-react"

import { getLucideIcon } from "@/components/dynamic-icon"

import {
  AREA_NAME_BASE_PX,
  DEFAULT_AREA_NAME_LOOK,
  areaNameFallback,
  areaNameFontPx,
  areaNameSize,
} from "./area-name-style"
import type { AreaNameLook } from "./area-name-style"
import { CELL } from "./canvas-geometry"

import { fontGrow } from "./readable"
import {
  AREA_INK_SHARE,
  AREA_STROKE_OPACITY,
  HANDLES,
  PATTERN_GAP,
  PATTERN_STROKE,
  labelColor,
  areaColor,
  areaIcon,
  areaLabelColor,
  areaName,
  areaNameHalo,
  areaNameHaloColor,
  PAGE_DARK,
  PAGE_LIGHT,
  areaPattern,
  boxCenter,
  handlePoint,
  labelBox,
  labelPlateBox,
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

/** The name's size at M, which Readable grows from (world px). */
const NAME_PX = AREA_NAME_BASE_PX
/** A fine pattern's share of the usual stroke opacity (Detail by zoom). */
const FINE_PATTERN = 0.45

/** An area type's pattern: its strokes over the fill, clipped to the
 * area's own outline (`clip`: a rect or polygon in world px). */
function PatternStrokes({
  id,
  area,
  color,
  clip,
  box,
  zoom,
  fine = false,
}: {
  id: string
  area: AreaShape
  color: string
  clip: React.ReactNode
  box: { x: number; y: number; w: number; h: number }
  /** Detail by zoom: thinner and fainter lines. */
  fine?: boolean
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
        strokeOpacity={PATTERN_STROKE.opacity * (fine ? FINE_PATTERN : 1)}
        strokeWidth={(PATTERN_STROKE.width * (fine ? 0.7 : 1)) / zoom}
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

/** A black-or-white area name's ink and halo for each theme, as CSS
 * variables the name's group reads (`AREA_INK_CLASS`). */
function areaNameInks(area: AreaShape): React.CSSProperties {
  const light = areaLabelColor(area, PAGE_LIGHT)
  const dark = areaLabelColor(area, PAGE_DARK)
  return {
    "--area-ink": light,
    "--area-ink-dark": dark,
    "--area-halo": areaNameHaloColor(light),
    "--area-halo-dark": areaNameHaloColor(dark),
  } as React.CSSProperties
}
const AREA_INK_CLASS =
  "text-(--area-ink) stroke-(--area-halo) dark:text-(--area-ink-dark) dark:stroke-(--area-halo-dark)"

/** A plate behind text, so it reads over lines - a label's, and an area
 * name's when its look asks for one: the theme's background (or `fill`)
 * with a hairline of the border. */
function Plate({
  x,
  y,
  width,
  height,
  font,
  fill,
  part,
}: {
  x: number
  y: number
  width: number
  height: number
  /** The text's size: the corners round with it. */
  font: number
  fill?: string | null
  part?: string
}) {
  return (
    <rect
      data-part={part}
      x={x}
      y={y}
      width={width}
      height={height}
      rx={Math.min(6, font * 0.2)}
      className={fill ? "stroke-border" : "fill-background stroke-border"}
      fill={fill ?? undefined}
      data-plate={fill ?? undefined}
      strokeWidth={1}
    />
  )
}

/** An area's name with its type's icon before it, in its box (`x`, `y`:
 * the top left, world px) at its look's size and colour, on a plate when
 * its look has one. A patterned area's name reads over its lines through
 * a halo of the background. */
function AreaName({
  area,
  name,
  x,
  y,
  ink,
  look,
  grow = 1,
}: {
  area: AreaShape
  name: string
  x: number
  y: number
  ink: string
  look: AreaNameLook
  /** Readable from afar: the name and its icon grown by this much. */
  grow?: number
}) {
  const icon = areaIcon(area)
  const Icon = icon ? getLucideIcon(icon) : null
  const namePx = areaNameFontPx(look, grow)
  const iconPx = namePx
  const box = areaNameSize(name, namePx, !!Icon, look.plate)
  const tx = x + box.pad + box.shift
  const ix = x + box.pad
  const baseline = y + box.baseline
  const mid = baseline - namePx * 0.35
  // A chosen colour is the name's ink as it is. On a plate the page is
  // under it: the area's own colour, as over a light fill. Otherwise, in
  // the area's own colour a name keeps some of the page's ink, so a pale
  // colour still reads, on a halo of the page; over a strong fill it is
  // black or white - judged against the fill as it reads over each
  // theme's page - on a halo of the other one, so the glyphs keep their
  // edges (a white name on a white halo smears).
  const chosen = look.color
  const own = !!chosen || look.plate || ink === areaColor(area)
  const base = look.plate && !chosen ? areaColor(area) : ink
  // Grown, it spills over tiles and lines: always on its halo - none on a
  // plate, which is its own backdrop.
  const halo = !look.plate && (!!chosen || areaNameHalo(area) || grow > 1)
  const fill = chosen
    ? chosen
    : own
      ? `color-mix(in oklab, ${base} ${AREA_INK_SHARE * 100}%, var(--foreground))`
      : "currentColor"
  const inks = own ? undefined : areaNameInks(area)
  return (
    <g
      pointerEvents="none"
      data-part="area-name"
      data-position={look.position}
      style={inks}
      className={inks ? AREA_INK_CLASS : undefined}
    >
      {look.plate && (
        <Plate
          part="area-name-plate"
          x={x}
          y={y}
          width={box.w}
          height={box.h}
          font={namePx}
        />
      )}
      {Icon && (
        <Icon
          data-part="area-icon"
          x={ix}
          y={mid - iconPx / 2}
          width={iconPx}
          height={iconPx}
          color={fill}
          strokeWidth={2.25}
        />
      )}
      <text
        x={tx}
        y={baseline}
        fontSize={namePx}
        fontWeight={600}
        fill={fill}
        className={halo && own ? "stroke-background" : undefined}
        stroke={halo ? undefined : "none"}
        strokeWidth={halo ? 3.5 * grow : undefined}
        strokeOpacity={halo ? (own ? 0.9 : 0.75) : undefined}
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
function OpensMark({
  x,
  y,
  ink,
  area,
  size = LINK_PX,
  onOpen,
}: {
  x: number
  y: number
  ink: string
  /** Its size (world px). */
  size?: number
  /** View, while a click on the area zooms: a click on the mark opens. */
  onOpen?: () => void
  /** An area's mark: black or white over a strong fill, as its name. */
  area?: AreaShape
}) {
  const inks = area && ink !== areaColor(area) ? areaNameInks(area) : null
  const mark = (
    <Link2
      data-part="opens-mark"
      x={x}
      y={y}
      width={size}
      height={size}
      color={inks ? "currentColor" : ink}
      strokeWidth={2.25}
      pointerEvents="none"
    />
  )
  const drawn = inks ? (
    <g style={inks} className={AREA_INK_CLASS}>
      {mark}
    </g>
  ) : (
    mark
  )
  if (!onOpen) return drawn
  return (
    <g
      data-part="opens-button"
      role="link"
      aria-label="Open the linked plan"
      style={{ cursor: "pointer", pointerEvents: "auto" }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
    >
      <rect
        x={x - size * 0.2}
        y={y - size * 0.2}
        width={size * 1.4}
        height={size * 1.4}
        fill="transparent"
      />
      {drawn}
    </g>
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
  multiSelected = false,
  minNamePx,
  nameAt,
  nameLook = DEFAULT_AREA_NAME_LOOK,
  pattern = "full",
  recedes = false,
  hot = false,
  onActivate,
  onFocusChange,
  onOpens,
}: {
  /** View, while a click zooms to it: its Opens mark opens the plan. */
  onOpens?: () => void
  /** View, from afar: Enter or Space on the focused area zooms to it. */
  onActivate?: () => void
  onFocusChange?: (focused: boolean) => void
  area: AreaShape
  /** The plan's filter leaves it out (its area type): faded. */
  recedes?: boolean
  /** View, from afar: under the pointer or focused, a click zooms to it -
   * its outline lit. */
  hot?: boolean
  /** Detail by zoom: the type's pattern as drawn, fine and faint, or left
   * out (a flat tint). */
  pattern?: "full" | "fine" | "none"
  /** Readable: the name never under this on screen (px). */
  minNamePx?: number
  /** Where the plan's label pass put the name - its box's top left
   * (cells) - or null where it would cover another text; left out, the
   * name sits where it always does. */
  nameAt?: Pt | null
  /** How its name is drawn: the plan's default under its own style. */
  nameLook?: AreaNameLook
  selected: boolean
  /** Picked with others (Ctrl/⌘-click) - walls go round them together. */
  multiSelected?: boolean
  /** The canvas zoom, for strokes that keep their screen size. */
  zoom?: number
  /** Takes the pointer (Edit with Select, or View). */
  interactive: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  onEdgeDoubleClick?: (seg: number, e: React.MouseEvent) => void
}) {
  const color = areaColor(area)
  const ink = areaLabelColor(area)
  const name = area.show_name && nameAt !== null ? areaName(area) : ""
  const dash = area.border === "dashed" ? "8 5" : undefined
  const on = selected || multiSelected || hot
  const strokeOpacity =
    area.border === "none" && !on ? 0 : on ? 1 : AREA_STROKE_OPACITY
  const clipId = `area-pattern-${area.id}`
  const grow = minNamePx ? fontGrow(NAME_PX, zoom, minNamePx) : 1
  const nameBox = areaNameSize(
    name,
    areaNameFontPx(nameLook, grow),
    !!getLucideIcon(areaIcon(area)),
    nameLook.plate
  )
  // A mark that opens: big enough on screen to press.
  const linkPx = onOpens ? Math.max(LINK_PX, 16 / zoom) : LINK_PX
  const linkGap = onOpens ? 4 / zoom : 4
  const common = {
    fill: color,
    fillOpacity: area.fill_opacity / 100,
    stroke: color,
    strokeOpacity,
    strokeWidth: (on ? 2.5 : 1.25) / zoom,
    strokeDasharray: dash,
  }
  const style: React.CSSProperties = {
    cursor: interactive ? "pointer" : undefined,
    pointerEvents: interactive ? "auto" : "none",
    opacity: recedes ? 0.35 : undefined,
    outline: "none",
  }
  // Focusable when a key can zoom to it; its lit outline is the ring.
  const keys = onActivate
    ? {
        tabIndex: 0,
        role: "button",
        "aria-label": `Zoom to ${areaName(area) || "area"}`,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return
          e.preventDefault()
          onActivate()
        },
        onFocus: () => onFocusChange?.(true),
        onBlur: () => onFocusChange?.(false),
      }
    : {}
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
        data-picked={multiSelected ? "" : undefined}
        style={style}
        onPointerDown={onPointerDown}
        aria-label={name || "Area"}
        {...keys}
      >
        <polygon points={outline} strokeLinejoin="round" {...common} />
        {pattern !== "none" && (
          <PatternStrokes
            id={clipId}
            area={area}
            color={color}
            zoom={zoom}
            fine={pattern === "fine"}
            clip={<polygon points={outline} />}
            box={{
              x: bx,
              y: by,
              w: Math.max(...xs) - bx,
              h: Math.max(...ys) - by,
            }}
          />
        )}
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
            x={px(cx) - nameBox.w / 2}
            y={px(cy) - nameBox.h / 2}
            ink={ink}
            look={nameLook}
            grow={grow}
          />
        )}
        {(area.opens || area.opens_hidden) && (
          <OpensMark
            x={px(cx) - linkPx / 2}
            y={px(cy) + (name ? NAME_PX : -linkPx / 2)}
            area={area}
            ink={ink}
            size={linkPx}
            onOpen={onOpens}
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
      data-picked={multiSelected ? "" : undefined}
      style={style}
      onPointerDown={onPointerDown}
      transform={
        area.rotation
          ? `rotate(${area.rotation},${px(cx)},${px(cy)})`
          : undefined
      }
      aria-label={name || "Area"}
      {...keys}
    >
      <rect
        x={px(area.x)}
        y={px(area.y)}
        width={w}
        height={h}
        rx={3}
        {...common}
      />
      {pattern !== "none" && (
        <PatternStrokes
          id={clipId}
          area={area}
          color={color}
          zoom={zoom}
          fine={pattern === "fine"}
          clip={
            <rect x={px(area.x)} y={px(area.y)} width={w} height={h} rx={3} />
          }
          box={{ x: px(area.x), y: px(area.y), w, h }}
        />
      )}
      {name && (nameAt || (w > 30 && h > 18) || grow > 1) && (
        <AreaName
          area={area}
          name={name}
          {...(nameAt
            ? { x: px(nameAt[0]), y: px(nameAt[1]) }
            : areaNameFallback(area, nameLook, nameBox, grow))}
          ink={ink}
          look={nameLook}
          grow={grow}
        />
      )}
      {(area.opens || area.opens_hidden) && w > linkPx + linkGap * 2 && (
        <OpensMark
          x={px(area.x) + w - linkPx - linkGap}
          y={px(area.y) + linkGap}
          area={area}
          ink={ink}
          size={linkPx}
          onOpen={onOpens}
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
  minFontPx,
  zoom = 1,
}: {
  label: LabelShape
  cellMm: number
  /** Readable: the text never under this on screen (px) - the label,
   * plate and all, grown about its centre. */
  minFontPx?: number
  /** The canvas zoom. */
  zoom?: number
  interactive: boolean
  /** View: a click opens its link (a pointer, not a move cursor). */
  viewing?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
}) {
  const box = labelBox(label, cellMm)
  const plateBox = label.plate ? labelPlateBox(label, cellMm) : box
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
  const grow = minFontPx ? fontGrow(size, zoom, minFontPx) : 1
  const transform =
    [
      label.rotation ? `rotate(${label.rotation},${px(cx)},${px(cy)})` : "",
      grow > 1
        ? `translate(${px(cx)},${px(cy)}) scale(${grow}) translate(${-px(cx)},${-px(cy)})`
        : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined
  return (
    <g
      data-label={label.id}
      data-grown={grow > 1 ? "" : undefined}
      transform={transform}
      onPointerDown={onPointerDown}
      style={{
        cursor: interactive ? (viewing ? "pointer" : "move") : undefined,
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      {/* The hit area, and the plate when it has one - never narrower
          than the text it backs. */}
      {label.plate ? (
        <Plate
          x={px(plateBox.x)}
          y={px(plateBox.y)}
          width={px(plateBox.width)}
          height={px(plateBox.height)}
          font={size}
          fill={plate.fill}
        />
      ) : (
        <rect
          x={px(box.x)}
          y={px(box.y)}
          width={px(box.width)}
          height={px(box.height)}
          fill="transparent"
          strokeWidth={0}
        />
      )}
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
