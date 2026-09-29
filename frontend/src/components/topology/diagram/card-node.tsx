import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"

import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { StatusBadge } from "@/components/status-badge"
import { CARD as INK, mix } from "@/lib/diagram/theme"
import { cn } from "@/lib/utils"
import { cardContent } from "./card-fields"
import type { CardPill } from "./card-fields"
import { CARD, PILL, nubRect, pillTop } from "./card-layout"
import { PhotoNode } from "./photo-node"
import type { DiagramCardData } from "./types"

// A Diagram card: a solid rounded box in the device role's colour, the name
// bold and centred at the top, the card lines centred under it, and at most
// one status pill inside the top-left corner. No role colour paints a
// neutral card. In Detailed mode each cabled interface is a small grey nub
// on the edge facing its far end.
//
// Every size and offset comes from `cardLayout` (card-layout.ts): the box
// React Flow reserves, the layout and the exports use the same numbers, so
// text placed here lands where the SVG and draw.io writers put it.
//
// A device the view shows as its photo is drawn by PhotoNode instead.

/** Handles exist only so React Flow draws the edges; the link edge works
 * out its own end points from the anchors. */
const HANDLE =
  "!pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"

/** The shared status pill at card scale, 1px border included in
 * `PILL.PAD_X`. */
const STATUS_PILL =
  "block h-4 max-w-24 shrink-0 truncate px-1.5 py-0 text-[9px] leading-[14px]"
/** The monitoring badge draws its edge inside (a ring), so its padding
 * takes the border's pixel too. */
const CHECK_PILL = "h-4 max-w-24 px-[7px] text-[9px] leading-[14px]"

/** A card's one pill at card scale: the monitoring badge while the device
 * is down or degraded, else its lifecycle status. The Hierarchy's header
 * wears the same. */
export function CardPillBadge({ pill }: { pill: CardPill }) {
  return pill.kind === "check" ? (
    <CheckStatusBadge status={pill.status} className={CHECK_PILL} />
  ) : (
    <StatusBadge status={pill.status} className={STATUS_PILL} />
  )
}

export const CardNode = memo(function CardNode(props: NodeProps) {
  const { data, selected } = props
  const d = data as DiagramCardData
  if (d.diagram.photo) return <PhotoNode {...props} />
  const { box, nubs } = d.diagram
  const { pill } = cardContent(d, { monitor: d.monitor })
  const fill = box.fill
  return (
    <div
      className={cn(
        "relative rounded-lg transition-opacity",
        !fill && "bg-muted text-foreground",
        selected && "outline-2 outline-offset-2 outline-primary",
        d.dimmed && "opacity-30"
      )}
      style={{
        width: box.w,
        height: box.h,
        ...(fill ? { backgroundColor: fill, color: box.ink ?? undefined } : {}),
      }}
      data-card={d.device_id}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={HANDLE}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={HANDLE}
      />
      {/* The 1px edge: the fill a step darker, so a pale role still reads
          on white paper; the border colour on a neutral card. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-lg border",
          !fill && "border-border",
          d.panel && "border-dashed"
        )}
        style={
          fill
            ? { borderColor: mix("#000000", fill, INK.EDGE_DARKEN) }
            : undefined
        }
      />
      {pill && (
        <span
          className="absolute flex"
          style={{ left: PILL.X, top: pillTop(box.stacked) }}
        >
          <CardPillBadge pill={pill} />
        </span>
      )}
      <div
        className="absolute inset-x-0 truncate text-center font-bold"
        style={{
          top: box.title.top,
          height: box.title.lh,
          lineHeight: `${box.title.lh}px`,
          fontSize: CARD.TITLE_SIZE,
          paddingInline: CARD.PAD_X,
        }}
        data-tip={box.title.text !== d.name ? d.name : undefined}
      >
        {box.title.text}
      </div>
      {box.lines.map((l) => (
        <div
          key={l.key}
          className="topo-cardline absolute inset-x-0 truncate text-center"
          style={{
            top: l.top,
            height: l.lh,
            lineHeight: `${l.lh}px`,
            fontSize: CARD.LINE_SIZE,
            paddingInline: CARD.PAD_X,
            opacity: INK.LINE_INK,
          }}
        >
          {l.text}
        </div>
      ))}
      {nubs.map((n) => {
        const r = nubRect(box.w, box.h, n.side, n.off)
        return (
          <span
            key={`${n.link}#${n.cable}${n.end}`}
            className="topo-nub absolute rounded-[2px] bg-muted-foreground/70"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            data-port={n.port}
            data-tip={n.port}
          />
        )
      })}
    </div>
  )
})
