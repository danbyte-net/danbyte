import { CELL } from "./canvas-geometry"
import {
  HANDLES,
  labelColor,
  areaColor,
  areaName,
  boxCenter,
  handlePoint,
  labelBox,
  labelFontCells,
  polygonCentroid,
  rotateHandlePoint,
} from "./shapes"
import type { AreaShape, Box, Handle, LabelShape, Pt } from "./shapes"
import type { GestureTarget, ShapeGestures } from "./use-shape-gestures"

// The areas and labels on the 2D plan, their selection handles, and what a
// drawing tool shows while it draws. World pixels (CELL per cell), inside
// the canvas's pan/zoom group.

const px = (v: number) => v * CELL

/** An area: a tinted rectangle (turned about its centre) or polygon with
 * its name in its top left (a polygon: at its middle). */
export function AreaShapeView({
  area,
  selected,
  interactive,
  onPointerDown,
  onEdgeDoubleClick,
}: {
  area: AreaShape
  selected: boolean
  /** Takes the pointer (Edit with Select, or View). */
  interactive: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  onEdgeDoubleClick?: (seg: number, e: React.MouseEvent) => void
}) {
  const color = areaColor(area)
  const name = area.show_name ? areaName(area) : ""
  const dash = area.border === "dashed" ? "8 5" : undefined
  const strokeOpacity = area.border === "none" ? 0 : selected ? 0.95 : 0.6
  const common = {
    fill: color,
    fillOpacity: area.fill_opacity / 100,
    stroke: color,
    strokeOpacity,
    strokeWidth: selected ? 2.5 : 1.5,
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
    return (
      <g
        data-area={area.id}
        style={style}
        onPointerDown={onPointerDown}
        aria-label={name || "Area"}
      >
        <polygon
          points={pts.map(([x, y]) => `${px(x)},${px(y)}`).join(" ")}
          strokeLinejoin="round"
          {...common}
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
          <text
            x={px(cx)}
            y={px(cy)}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={12}
            fontWeight={600}
            fill={color}
            pointerEvents="none"
          >
            {name}
          </text>
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
      {name && w > 30 && h > 18 && (
        <text
          x={px(area.x) + 6}
          y={px(area.y) + 15}
          fontSize={12}
          fontWeight={600}
          fill={color}
          pointerEvents="none"
        >
          {name}
        </text>
      )}
    </g>
  )
}

/** A label: its text at its real size, optionally on a plate. */
export function LabelShapeView({
  label,
  cellMm,
  interactive,
  onPointerDown,
}: {
  label: LabelShape
  cellMm: number
  interactive: boolean
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
        cursor: interactive ? "move" : undefined,
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
        className={label.plate ? "fill-background stroke-border" : undefined}
        fill={label.plate ? undefined : "transparent"}
        strokeWidth={label.plate ? 1 : 0}
      />
      <text
        className={color.className}
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
    </g>
  )
}

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
  const s = 9 / zoom
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
  const s = 9 / zoom
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
