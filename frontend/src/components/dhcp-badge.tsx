import { Badge } from "@/components/ui/badge"

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

export function DhcpBadge({ state }: { state: DhcpState }) {
  if (state === "leased") {
    return (
      <Badge
        variant="outline"
        className="border-sky-500/60 bg-sky-500/15 text-[9px] text-sky-700 dark:text-sky-300"
        title="Leased or reserved by DHCP right now"
      >
        DHCP
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="border-sky-400/40 text-[9px] text-sky-600/80 dark:text-sky-400/70"
      title="Inside a DHCP scope pool — managed by DHCP, not currently leased"
    >
      DHCP
    </Badge>
  )
}
