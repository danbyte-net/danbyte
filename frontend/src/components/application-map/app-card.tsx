import { memo } from "react"
import type { NodeProps } from "@xyflow/react"

import { NODE_KINDS } from "@/components/topology/node-registry"
import { cn } from "@/lib/utils"

import { ACCENT } from "./document"
import type { AppCardData } from "./model"

// An Application map card (#163): the topology Diagram's own card, and on
// an application's card its colour as a thin bar along the left edge -
// the colour its install lines are drawn in. The export draws the same bar
// (document.ts `accentNode`).

const Card = NODE_KINDS.card.component

export const AppCard = memo(function AppCard(props: NodeProps) {
  const d = props.data as AppCardData
  return (
    <>
      <Card {...props} />
      {d.accent && (
        <span
          aria-hidden
          data-accent={d.accent}
          className={cn(
            "pointer-events-none absolute left-0 rounded-r-sm transition-opacity",
            d.dimmed && "opacity-30"
          )}
          style={{
            top: ACCENT.INSET,
            bottom: ACCENT.INSET,
            width: ACCENT.W,
            backgroundColor: d.accent,
          }}
        />
      )}
    </>
  )
})
