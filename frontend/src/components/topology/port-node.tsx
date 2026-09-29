import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// A port on its own: a node the port-level trace graph carries (an
// interface, or a patch panel's front or rear port - `type` interface,
// front_port or rear_port). The trace maps draw the device-level graph,
// where a patch panel is a Diagram card with a nub on each front and rear
// port its run uses; a graph that still names ports draws each as this
// neutral card - the port name over its device and kind - sized here so
// the layout keeps its box. The Diagram's lines work out their own ends,
// so the handles only let React Flow draw them.

export interface PortData {
  name: string
  kind?: string
  device_name?: string
  is_splitter?: boolean
  dimmed?: boolean
}

const PAD_X = 20
const NAME_CHAR = 6.7 // 11px mono
const SUB_CHAR = 5.6 // 10px sans, generous
const SPLITTER = 50
const H = 40

const subText = (d: PortData) =>
  [d.device_name, d.kind?.replace("_", " ")].filter(Boolean).join(" · ")

/** A port node's box: its longer line, padded; one height. */
export function portSize(d: PortData): { width: number; height: number } {
  const name = d.name.length * NAME_CHAR + (d.is_splitter ? SPLITTER : 0)
  const sub = subText(d).length * SUB_CHAR
  return { width: Math.ceil(Math.max(72, name, sub) + PAD_X), height: H }
}

const HANDLE =
  "!pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"

export function PortNode({ data, selected }: NodeProps) {
  const d = data as unknown as PortData
  const { width, height } = portSize(d)
  return (
    <div
      className={cn(
        "flex flex-col justify-center rounded-lg border border-border bg-card px-2.5 transition-opacity",
        selected && "outline-2 outline-offset-2 outline-primary",
        d.dimmed && "opacity-30"
      )}
      style={{ width, height }}
      data-port-node={d.name}
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
      <div className="flex items-center gap-1.5 truncate font-mono text-[11px] leading-4 font-medium">
        {d.name}
        {d.is_splitter && (
          <Badge variant="secondary" className="h-4 px-1 font-sans text-[9px]">
            Splitter
          </Badge>
        )}
      </div>
      <div className="truncate text-[10px] leading-4 text-muted-foreground">
        {subText(d)}
      </div>
    </div>
  )
}
