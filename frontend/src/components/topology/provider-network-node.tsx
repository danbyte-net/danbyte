import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { Cloud } from "lucide-react"

import type { TopoProviderNetworkData } from "@/lib/api"
import { readableText } from "@/lib/color"
import { CARD as INK, mix } from "@/lib/diagram/theme"
import { cn } from "@/lib/utils"
import { normalizeHex } from "./diagram/card-layout"
import { GroupName } from "./group-node"
import { GROUP_TEXT, groupBox } from "./group-size"
import { handleId } from "./port-handles"

// A provider network on the topology (#466): the hub a set of circuits
// meets at - an MPLS cloud, a carrier's fabric. One card per network, sized
// as a site card (group-size.ts: it grows to fit its whole name), its
// circuits drawn to it from the devices (or the site cards) at their site
// ends. Neutral like a site card, unless the network or its provider has a
// colour (#540): then the card is filled with it, the text black or white
// as a role-coloured device card's, and its edge the fill a step darker.

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
  const box = groupBox(d)
  const fill = normalizeHex(d.color)
  // On a fill the muted rows keep the fill's ink, a little lighter.
  const muted = fill ? "opacity-80" : "text-muted-foreground"
  return (
    <div
      className={cn(
        "flex flex-col justify-center gap-1 overflow-hidden rounded-lg border-2 px-3 transition-opacity",
        !fill && "bg-card",
        selected
          ? "border-primary ring-2 ring-primary/30"
          : !fill && "border-border",
        d.dimmed && "opacity-30"
      )}
      style={{
        width: box.width,
        height: box.height,
        ...(fill
          ? {
              backgroundColor: fill,
              color: readableText(fill),
              ...(selected
                ? {}
                : { borderColor: mix("#000000", fill, INK.EDGE_DARKEN) }),
            }
          : {}),
      }}
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
      <div className="flex items-baseline gap-2">
        <Cloud
          className={cn("size-4 shrink-0 self-start", muted)}
          style={{ marginTop: (GROUP_TEXT.NAME_LH - GROUP_TEXT.ICON) / 2 }}
          aria-hidden
        />
        <GroupName rows={box.rows} />
        <span className={cn("shrink-0 text-[11px] whitespace-nowrap", muted)}>
          <span className="num">{n}</span> {n === 1 ? "circuit" : "circuits"}
        </span>
      </div>
      <div className={cn("truncate pl-6 text-[11px]", muted)}>
        {d.provider.name}
      </div>
    </div>
  )
})
