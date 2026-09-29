import { Handle, Position, type NodeProps } from "@xyflow/react"

import type { CheckStatus, TopoNode } from "@/lib/api"
import { CARD as INK, mix } from "@/lib/diagram/theme"
import { cn } from "@/lib/utils"
import { cardContent, withCardLines } from "./diagram/card-fields"
import { CARD, PILL, pillTop } from "./diagram/card-layout"
import { CardPillBadge } from "./diagram/card-node"
import { hierCardBox } from "./hier-card"
import type { HierCardData } from "./hier-card"
import { hierHeight, hierarchyWidth, type HierPortPos } from "./layout"
import { handleId } from "./port-handles"

export { hierarchyWidth } from "./layout"

// The Hierarchy view's card: the Diagram's Simple card as its header - the
// role's colour, the name bold, the card lines under it, the status pill in
// the top-left corner - over a neutral body whose port chips float at the
// exact heights the layout aligned with their peers, so cables run
// near-straight between them. The header box comes from the build
// (hier-card.ts); the layout sized the card from the same numbers.

export type HierData = TopoNode["data"] &
  HierCardData & {
    /** Search miss or out of the spotlight: drawn faded. */
    dimmed?: boolean
    portPos?: Record<string, HierPortPos>
    portSpan?: number
    /** The device's monitoring state, merged in by the canvas. */
    monitor?: CheckStatus | null
  }

const HANDLE = "topo-conn"

export function HierarchyNode({ data, selected }: NodeProps) {
  const d = data as HierData
  const box = d.hierCard ?? hierCardBox(d)
  const width = hierarchyWidth({ ...d, hierCard: box })
  const height = hierHeight(d.portSpan ?? 0, box.h)
  const { pill } = cardContent(withCardLines(d), { monitor: d.monitor })
  const fill = box.fill
  return (
    <div
      className={cn(
        "relative rounded-lg border border-border bg-card transition-opacity",
        d.panel && "border-dashed",
        selected && "outline-2 outline-offset-2 outline-primary",
        d.dimmed && "opacity-30"
      )}
      style={{ width, height }}
      data-hier={d.device_id}
    >
      {/* Whole-card fallbacks (LLDP ghost edges). */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />
      {/* The header: a Diagram card over the top of the body, its edge
          included, so the card's own border runs on only below it. */}
      <div
        className={cn(
          "absolute -inset-x-px -top-px rounded-t-lg",
          !fill && "bg-muted text-foreground"
        )}
        style={{
          height: box.h,
          ...(fill
            ? { backgroundColor: fill, color: box.ink ?? undefined }
            : {}),
        }}
      >
        {/* The fill a step darker, as on the Diagram card, so a pale role
            still reads on white paper; the border colour on a neutral
            card. */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 rounded-t-lg border",
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
      </div>
      {/* Port chips at their aligned offsets, riding the card's edges. */}
      {Object.entries(d.portPos ?? {}).map(([name, pos]) => {
        const id = handleId(name, pos.side)
        return (
          <div
            key={name}
            className="absolute flex items-center gap-1 rounded border border-border bg-muted/60 px-1 py-px"
            style={{
              // The chip's centre sits exactly at the aligned offset, so the
              // handle (and the cable) land where the layout promised.
              top: pos.off - 8,
              ...(pos.side === "L" ? { left: 5 } : { right: 5 }),
            }}
            data-tip={name}
          >
            <Handle
              type="target"
              id={id}
              position={pos.side === "L" ? Position.Left : Position.Right}
              className={HANDLE}
            />
            <Handle
              type="source"
              id={id}
              position={pos.side === "L" ? Position.Left : Position.Right}
              className={HANDLE}
            />
            <span className="topo-portname max-w-28 truncate font-mono text-[9px] leading-none">
              {name}
            </span>
          </div>
        )
      })}
    </div>
  )
}
