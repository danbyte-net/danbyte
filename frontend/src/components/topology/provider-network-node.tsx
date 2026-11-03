import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { Cloud } from "lucide-react"

import type { TopoProviderNetworkData } from "@/lib/api"
import { GROUP_H, GROUP_W } from "./group-size"
import { handleId } from "./port-handles"

// A provider network on the topology (#466): the hub a set of circuits
// meets at - an MPLS cloud, a carrier's fabric. One card per network, the
// size of a site card, its circuits drawn to it from the devices (or the
// site cards) at their site ends. Neutral like a site card: it has no role
// colour of its own.

export { GROUP_H as PN_H, GROUP_W as PN_W }

export const PROVIDER_NETWORK = "provider_network"

const SIDES = [
  { side: "L", pos: Position.Left },
  { side: "R", pos: Position.Right },
  { side: "T", pos: Position.Top },
  { side: "B", pos: Position.Bottom },
] as const

const HANDLE = "!h-1 !w-1 !border-0 !bg-transparent"

/** Whether a payload node's data is a provider network's. */
export function isProviderNetwork(
  data: unknown
): data is TopoProviderNetworkData {
  return !!data && (data as { kind?: string }).kind === PROVIDER_NETWORK
}

export const ProviderNetworkNode = memo(function ProviderNetworkNode({
  data,
  selected,
}: NodeProps) {
  const d = data as unknown as TopoProviderNetworkData
  const n = d.circuit_count
  return (
    <div
      className={`flex flex-col justify-center gap-1 overflow-hidden rounded-lg border-2 bg-card px-3 transition-opacity ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      } ${d.dimmed ? "opacity-30" : ""}`}
      style={{ width: GROUP_W, height: GROUP_H }}
      data-provider-network={d.provider_network_id}
    >
      {SIDES.map(({ side, pos }) => (
        <span key={side}>
          <Handle
            type="target"
            id={handleId("n", side)}
            position={pos}
            isConnectable={false}
            className={HANDLE}
          />
          <Handle
            type="source"
            id={handleId("n", side)}
            position={pos}
            isConnectable={false}
            className={HANDLE}
          />
        </span>
      ))}
      <div className="flex items-center gap-2">
        <Cloud className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {d.name}
        </span>
        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
          <span className="num">{n}</span> {n === 1 ? "circuit" : "circuits"}
        </span>
      </div>
      <div className="truncate pl-6 text-[11px] text-muted-foreground">
        {d.provider.name}
      </div>
    </div>
  )
})
