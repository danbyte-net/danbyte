import { CELL } from "./canvas-geometry"
import { HANDLE_PX } from "./shape-layer"
import { HANDLES, handlePoint } from "./shapes"
import type { Handle } from "./shapes"
import { doorLeaf, pointAlong } from "./structure"
import type { RaisedRow, RunRow, WallRow } from "./structure"
import type {
  StructureGestures,
  StructurePreview,
} from "./use-structure-gestures"

const px = (v: number) => v * CELL

/** A hover hint on a handle: what a drag of it does, or nothing. */
export type HintFn = (text: string | null, e?: React.PointerEvent) => void

const hover = (hint: HintFn | undefined, text: string) => ({
  onPointerEnter: (e: React.PointerEvent) => hint?.(text, e),
  onPointerLeave: () => hint?.(null),
})

/** The cursor that says which way a handle drags. */
export function resizeCursor(h: Handle): string {
  return h === "n" || h === "s"
    ? "ns-resize"
    : h === "e" || h === "w"
      ? "ew-resize"
      : h === "nw" || h === "se"
        ? "nwse-resize"
        : "nesw-resize"
}

/** A resize cursor along a direction on the plan (degrees, y down). */
function cursorAlong(dx: number, dy: number): string {
  const a = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180
  if (a < 22.5 || a >= 157.5) return "ew-resize"
  if (a < 67.5) return "nwse-resize"
  if (a < 112.5) return "ns-resize"
  return "nesw-resize"
}

/**
 * A selected wall's or tray's handles: a round one on each point (drag it;
 * dropped on another run's end the two join) and a square one in the
 * middle of each segment (drag the segment, its neighbours follow). The
 * same look and screen size as every other handle on the plan.
 */
export function RunHandles({
  row,
  zoom,
  gestures,
  hint,
  onVertexMenu,
}: {
  row: RunRow
  zoom: number
  gestures: StructureGestures
  hint?: HintFn
  onVertexMenu?: (index: number, e: React.MouseEvent) => void
}) {
  const s = HANDLE_PX / zoom
  const last = row.points.length - 1
  return (
    <g data-handles="run">
      {row.points.slice(0, -1).map(([x, y], i) => {
        const [ex, ey] = row.points[i + 1]
        const cx = px((x + ex) / 2)
        const cy = px((y + ey) / 2)
        const deg = (Math.atan2(ey - y, ex - x) * 180) / Math.PI
        // Square to the segment, the way it can be pushed.
        const cursor = cursorAlong(-(ey - y), ex - x)
        return (
          <rect
            key={`m${i}`}
            data-segment-handle={i}
            x={cx - s / 2}
            y={cy - s / 2}
            width={s}
            height={s}
            rx={1.5 / zoom}
            transform={`rotate(${deg},${cx},${cy})`}
            className="fill-background stroke-primary"
            strokeWidth={1.5 / zoom}
            style={{ cursor }}
            onPointerDown={(e) => gestures.segmentDown(row, i, e)}
            {...hover(hint, "Drag to move this segment")}
          />
        )
      })}
      {row.points.map(([x, y], i) => (
        <rect
          key={`v${i}`}
          data-vertex={i}
          x={px(x) - s / 2}
          y={px(y) - s / 2}
          width={s}
          height={s}
          rx={s / 2}
          className="fill-background stroke-primary"
          strokeWidth={1.5 / zoom}
          style={{ cursor: "move" }}
          onPointerDown={(e) => gestures.vertexDown(row, i, e)}
          onContextMenu={(e) => onVertexMenu?.(i, e)}
          {...hover(
            hint,
            i === 0 || i === last
              ? "Drag to move this end · drop it on another end to join"
              : "Drag to move this point"
          )}
        />
      ))}
    </g>
  )
}

/** A selected raised floor's eight resize handles. */
export function RectHandles({
  row,
  zoom,
  gestures,
  hint,
}: {
  row: RaisedRow
  zoom: number
  gestures: StructureGestures
  hint?: HintFn
}) {
  const s = HANDLE_PX / zoom
  const box = { ...row, rotation: 0 }
  return (
    <g data-handles="raised">
      {HANDLES.map((h) => {
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
            style={{ cursor: resizeCursor(h) }}
            onPointerDown={(e) => gestures.rectHandleDown(row, h, e)}
            {...hover(hint, "Drag to resize")}
          />
        )
      })}
    </g>
  )
}

/**
 * A selected door's handles: a square at each end (drag to resize along the
 * wall), a round one in its middle (drag to slide it along the wall) and a
 * round one at the open leaf's tip (click to flip the swing, as F does).
 */
export function DoorHandles({
  wall,
  index,
  zoom,
  gestures,
  hint,
  onFlip,
}: {
  wall: WallRow
  index: number
  zoom: number
  gestures: StructureGestures
  hint?: HintFn
  onFlip: () => void
}) {
  const o = wall.openings[index]
  if (!o || !wall.points[o.seg + 1]) return null
  const s = HANDLE_PX / zoom
  const a = pointAlong(wall.points, o.seg, o.from)
  const b = pointAlong(wall.points, o.seg, o.to)
  const [sx, sy] = wall.points[o.seg]
  const [ex, ey] = wall.points[o.seg + 1]
  const along = cursorAlong(ex - sx, ey - sy)
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const leaf = doorLeaf(wall.points, o)
  // Without a leaf yet, the flip handle sits off the gap's middle.
  const len = Math.hypot(ex - sx, ey - sy) || 1
  const off = (o.to - o.from) / 2
  const flipAt = leaf
    ? leaf.open
    : [mid[0] + ((ey - sy) / len) * off, mid[1] - ((ex - sx) / len) * off]
  return (
    <g data-handles="door">
      {(
        [
          ["from", a],
          ["to", b],
        ] as const
      ).map(([end, p]) => (
        <rect
          key={end}
          data-door-end={end}
          x={px(p[0]) - s / 2}
          y={px(p[1]) - s / 2}
          width={s}
          height={s}
          rx={1.5 / zoom}
          className="fill-background stroke-primary"
          strokeWidth={1.5 / zoom}
          style={{ cursor: along }}
          onPointerDown={(e) => gestures.doorEndDown(wall.id, index, end, e)}
          {...hover(hint, "Drag to resize")}
        />
      ))}
      <rect
        data-door-middle=""
        x={px(mid[0]) - s / 2}
        y={px(mid[1]) - s / 2}
        width={s}
        height={s}
        rx={s / 2}
        className="fill-background stroke-primary"
        strokeWidth={1.5 / zoom}
        style={{ cursor: "move" }}
        onPointerDown={(e) => gestures.doorSlideDown(wall.id, index, e)}
        {...hover(hint, "Drag to slide along the wall")}
      />
      <circle
        data-door-flip=""
        cx={px(flipAt[0])}
        cy={px(flipAt[1])}
        r={s / 1.6}
        className="fill-primary stroke-background"
        strokeWidth={1.5 / zoom}
        style={{ cursor: "pointer" }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          onFlip()
        }}
        {...hover(hint, "Click to flip the swing (F)")}
      />
    </g>
  )
}

/** What a structure gesture shows while it runs: the door being drawn, the
 * guides the dragged point lined up on and the width beside the pointer. */
export function StructureOverlay({
  preview,
  walls,
  zoom,
  width,
  height,
}: {
  preview: StructurePreview
  walls: readonly WallRow[]
  zoom: number
  /** The plan in world pixels - the guides run across it. */
  width: number
  height: number
}) {
  const { door, guides, readout } = preview
  const wall = door ? walls.find((w) => w.id === door.wallId) : null
  const dash = `${4 / zoom} ${3 / zoom}`
  return (
    <g pointerEvents="none" data-part="structure-overlay">
      {wall && door && door.to > door.from && wall.points[door.seg + 1] && (
        <line
          data-door-draft=""
          x1={px(pointAlong(wall.points, door.seg, door.from)[0])}
          y1={px(pointAlong(wall.points, door.seg, door.from)[1])}
          x2={px(pointAlong(wall.points, door.seg, door.to)[0])}
          y2={px(pointAlong(wall.points, door.seg, door.to)[1])}
          className="stroke-primary"
          strokeWidth={6 / zoom}
          strokeOpacity={0.6}
        />
      )}
      {guides?.x != null && (
        <line
          x1={px(guides.x)}
          y1={0}
          x2={px(guides.x)}
          y2={height}
          className="stroke-primary/60"
          strokeWidth={1 / zoom}
          strokeDasharray={dash}
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
          strokeDasharray={dash}
        />
      )}
      {readout && (
        <g
          data-part="readout"
          transform={`translate(${px(readout.at[0]) + 12 / zoom},${px(readout.at[1]) - 12 / zoom}) scale(${1 / zoom})`}
        >
          <rect
            x={-4}
            y={-13}
            width={readout.text.length * 6.6 + 8}
            height={18}
            rx={4}
            className="fill-popover stroke-border"
          />
          <text
            fontSize={11}
            className="num fill-popover-foreground"
            pointerEvents="none"
          >
            {readout.text}
          </text>
        </g>
      )}
    </g>
  )
}
