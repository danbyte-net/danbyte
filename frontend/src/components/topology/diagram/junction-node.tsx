import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"

import { JUNCTION } from "./card-layout"

// Where a breakout cable splits: its trunk ends here and each leg leaves
// from here. A small dot in the cable's own colour - part of the cable's
// drawing, not a status. It never moves on its own; the drop that moves
// its trunk's card re-places it.

/** Handles exist only so React Flow draws the edges; the link edge works
 * out its own end points. */
const HANDLE =
  "!pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"

export const JunctionNode = memo(function JunctionNode({ data }: NodeProps) {
  const stroke = (data as { stroke?: string }).stroke
  return (
    <div
      className="topo-junction pointer-events-none relative"
      style={{ width: JUNCTION.w, height: JUNCTION.h }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className={HANDLE}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={HANDLE}
      />
      <svg className="block" width={JUNCTION.w} height={JUNCTION.h} aria-hidden>
        <circle
          cx={JUNCTION.w / 2}
          cy={JUNCTION.h / 2}
          r={JUNCTION.w / 2}
          style={{
            fill:
              stroke ?? "var(--xy-edge-stroke, var(--xy-edge-stroke-default))",
          }}
        />
      </svg>
    </div>
  )
})
