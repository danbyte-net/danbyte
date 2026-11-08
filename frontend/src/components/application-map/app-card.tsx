import { memo } from "react"
import type { NodeProps } from "@xyflow/react"

import { NODE_KINDS } from "@/components/topology/node-registry"
import { cn } from "@/lib/utils"

import { ACCENT } from "./document"
import type { AppCardData } from "./model"

// An Application map card (#163): the topology Diagram's own card, and on
// an application's card its colour as its left edge - full height, following
// the card's rounded corners, so it reads as part of the card rather than a
// tab stuck beside it. It is the colour its install lines are drawn in. The
// export draws the same edge (document.ts `accentNode`).

const Card = NODE_KINDS.card.component

export const AppCard = memo(function AppCard(props: NodeProps) {
  const d = props.data as AppCardData
  return (
    <>
      <Card {...props} />
      {d.accent && (
        // Clipped to the card's own rounded outline, so the colour follows
        // the corners exactly instead of sitting beside them as a strip.
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden rounded-lg transition-opacity",
            d.dimmed && "opacity-30"
          )}
        >
          <span
            data-accent={d.accent}
            className="absolute left-0"
            style={{
              top: ACCENT.INSET,
              bottom: ACCENT.INSET,
              width: ACCENT.W,
              backgroundColor: d.accent,
            }}
          />
        </span>
      )}
    </>
  )
})
