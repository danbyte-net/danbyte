import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"

import type { RoutingRouterData } from "@/lib/api"
import { CARD as INK, mix } from "@/lib/diagram/theme"
import { cn } from "@/lib/utils"
import { CARD } from "../diagram/card-layout"
import type { CardBox } from "../diagram/card-layout"
import { CardTitle } from "../diagram/card-node"

// A router on the Routing tab: the Diagram's card - its role's colour, the
// name bold at the top and never cut, the lines under it - sized by the
// same `cardLayout`, so the exports print it where it stands. A box that
// runs no routing process of its own (the far end of a session) has a
// dashed edge.

export interface RouterNodeData extends RoutingRouterData {
  box: CardBox
  dimmed?: boolean
  [key: string]: unknown
}

/** Handles only so React Flow draws the lines; the line works out its own
 * ends from the card boxes. */
const HANDLE =
  "!pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"

export const RouterNode = memo(function RouterNode({
  data,
  selected,
}: NodeProps) {
  const d = data as RouterNodeData
  const { box } = d
  const fill = box.fill
  return (
    <div
      className={cn(
        "relative rounded-lg transition-opacity",
        !fill && "bg-muted text-foreground",
        selected && "outline-2 outline-offset-2 outline-map-accent",
        d.dimmed && "opacity-30"
      )}
      style={{
        width: box.w,
        height: box.h,
        ...(fill ? { backgroundColor: fill, color: box.ink ?? undefined } : {}),
      }}
      data-router={d.device_id ?? d.vm_id}
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
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-lg border",
          !fill && "border-border",
          !d.router && "border-dashed"
        )}
        style={
          fill
            ? { borderColor: mix("#000000", fill, INK.EDGE_DARKEN) }
            : undefined
        }
      />
      <CardTitle box={box} />
      {box.lines.map((l) => (
        <div
          key={l.key}
          className="absolute inset-x-0 truncate text-center"
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
    </div>
  )
})
