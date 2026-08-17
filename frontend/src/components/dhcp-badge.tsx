import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// DHCP marker, one hue (sky) so the states read as the same family,
// distinguished by fill and border:
//
//   leased    — solid fill: held right now (a reservation or an active lease).
//   scope     — faint outline: inside a scope's pool range, DHCP-managed space
//               that isn't currently handed out.
//   exclusion — dashed outline, "EXCL" label: carved *out* of the pool for
//               static use; the DHCP server never hands these out.
//
// Used on IP rows (registered and free), the prefix list, IP-range surfaces,
// and the prefix IPs pane. Deriving state from data — never from a name —
// keeps the palette honest.
export type DhcpState = "leased" | "scope" | "exclusion"

const COPY: Record<
  DhcpState,
  { label: string; className: string; hint: string }
> = {
  leased: {
    label: "DHCP",
    className:
      "border-sky-500/60 bg-sky-500/15 text-[9px] text-sky-700 dark:text-sky-300",
    hint: "Leased or reserved by DHCP right now",
  },
  scope: {
    label: "DHCP",
    className:
      "border-sky-400/40 text-[9px] text-sky-600/80 dark:text-sky-400/70",
    hint: "Inside a DHCP scope pool — managed by DHCP, not currently leased",
  },
  exclusion: {
    label: "DHCP EXCL",
    className:
      "border-dashed border-sky-400/50 text-[9px] text-sky-600/80 dark:text-sky-400/70",
    hint: "DHCP exclusion — carved out of the scope pool for static use; the server never hands these addresses out",
  },
}

export function DhcpBadge({ state }: { state: DhcpState }) {
  const { label, className, hint } = COPY[state]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={className}>
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel">{hint}</TooltipContent>
    </Tooltip>
  )
}
