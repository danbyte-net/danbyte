import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Two-state DHCP marker, one hue (sky) at two intensities so the states read
// as the same family, distinguished by fill:
//
//   leased — solid fill: held right now (a reservation or an active lease).
//   scope  — faint outline: inside a scope's pool range, DHCP-managed space
//            that isn't currently handed out.
//
// Used on IP rows (registered and free), the prefix list, and the prefix IPs
// pane. Deriving state from data — never from a name — keeps the palette honest.
export type DhcpState = "leased" | "scope"

const COPY: Record<DhcpState, { className: string; hint: string }> = {
  leased: {
    className: "border-sky-500/60 bg-sky-500/15 text-[9px] text-sky-700 dark:text-sky-300",
    hint: "Leased or reserved by DHCP right now",
  },
  scope: {
    className: "border-sky-400/40 text-[9px] text-sky-600/80 dark:text-sky-400/70",
    hint: "Inside a DHCP scope pool — managed by DHCP, not currently leased",
  },
}

export function DhcpBadge({ state }: { state: DhcpState }) {
  const { className, hint } = COPY[state]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={className}>
          DHCP
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}
