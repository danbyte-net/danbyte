import { createContext, useContext } from "react"
import { Link } from "@tanstack/react-router"
import { NodeToolbar, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { ArrowUpRight, Columns2, Rows2, Trash2, Ungroup } from "lucide-react"

import { cn } from "@/lib/utils"
import { bandLook, ToolButton } from "./band-node"
import type { ChassisNodeData } from "./build-diagram"
import { CHASSIS, CHASSIS_DRAG_HANDLE } from "./chassis"
import type { ChassisOrient } from "./chassis"

/**
 * A virtual chassis drawn as a stack (chassis.ts): a band-grey frame
 * behind its members, with a slim strip carrying the chassis' name down
 * its left side (top to bottom) or across its top (left to right). The
 * strip is the grip - dragging it moves the stack, members and all - and
 * the name opens the chassis. Like a band it lies under the cables,
 * blended with them, and lets every click but the strip's through.
 *
 * Selected, its toolbar turns it top to bottom or left to right, draws its
 * members apart, opens the chassis and, on a hand-picked map where it was
 * placed, takes it off the map.
 */

/** What a stack's toolbar and menu do, by chassis id. The page provides
 * them; without, the frame has no toolbar. */
export interface ChassisActions {
  onOrient: (vc: string, orient: ChassisOrient) => void
  /** Draw its members apart on this view. */
  onUnstack: (vc: string) => void
  /** Placed on this hand-picked map: take it off. */
  onRemove?: (vc: string) => void
  /** Was it placed on the map (Remove applies)? */
  placed?: (vc: string) => boolean
}

export const ChassisActionsContext = createContext<ChassisActions | null>(null)

/** The line on a stack's strip, in a tooltip: its size and the cables the
 * frame stands for. */
export function chassisTip(d: Pick<ChassisNodeData, "members" | "inner">) {
  const n = d.members.length
  const members = `${n} ${n === 1 ? "member" : "members"}`
  return d.inner
    ? `${members} · ${d.inner} ${d.inner === 1 ? "cable" : "cables"} between them`
    : members
}

export function ChassisNode({ data, selected }: NodeProps) {
  const d = data as ChassisNodeData
  const act = useContext(ChassisActionsContext)
  const look = bandLook(null)
  const v = d.orient === "v"
  const placed = !!act?.onRemove && !!act.placed?.(d.vc.id)
  return (
    <>
      <NodeToolbar
        isVisible={selected && !!act}
        position={Position.Top}
        offset={8}
      >
        {act && (
          <div className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md">
            <ToolButton
              label="Top-down"
              active={v}
              onClick={() => act.onOrient(d.vc.id, "v")}
              icon={<Rows2 className="size-3" />}
            />
            <ToolButton
              label="Left-right"
              active={!v}
              onClick={() => act.onOrient(d.vc.id, "h")}
              icon={<Columns2 className="size-3" />}
            />
            <span className="mx-0.5 h-4 w-px bg-border" />
            <ToolButton
              label="Unstack"
              onClick={() => act.onUnstack(d.vc.id)}
              icon={<Ungroup className="size-3" />}
            />
            <Link
              to="/virtual-chassis/$id"
              params={{ id: d.vc.id }}
              aria-label="Open virtual chassis"
              data-tip="Open virtual chassis"
              data-tip-plain=""
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowUpRight className="size-3" />
            </Link>
            {placed && (
              <>
                <span className="mx-0.5 h-4 w-px bg-border" />
                <ToolButton
                  label="Remove from map"
                  onClick={() => act.onRemove?.(d.vc.id)}
                  icon={<Trash2 className="size-3" />}
                  danger
                />
              </>
            )}
          </div>
        )}
      </NodeToolbar>
      <div
        className={cn(
          "chassis-body relative h-full w-full rounded-lg border",
          look.className,
          selected && "ring-2 ring-primary/40"
        )}
        style={{ ...look.style, borderColor: look.edge }}
        data-chassis={d.orient}
      >
        <div
          className={cn(
            CHASSIS_DRAG_HANDLE,
            "pointer-events-auto absolute flex cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing",
            v ? "inset-y-0 left-0" : "inset-x-0 top-0"
          )}
          style={v ? { width: CHASSIS.STRIP } : { height: CHASSIS.STRIP }}
          data-tip={chassisTip(d)}
          data-tip-plain=""
        >
          <div
            className={cn(
              "flex max-h-full max-w-full items-center justify-center",
              v && "rotate-180 [writing-mode:vertical-rl]"
            )}
          >
            <Link
              to="/virtual-chassis/$id"
              params={{ id: d.vc.id }}
              className="nodrag truncate text-[11px] leading-none font-semibold whitespace-nowrap text-foreground/75 hover:text-foreground hover:underline"
            >
              {d.vc.name}
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}
