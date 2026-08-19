import { Pause, Power, PowerOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"

/** The hypervisor's reported power state for a VM.
 *
 * Deliberately *not* a `StatusBadge`. Status is the operator's lifecycle field
 * (staged / active / decommissioning); power is runtime fact from the
 * hypervisor, and a VM is routinely Active **and** powered off. So this reads
 * as a quieter, outlined companion rather than a second coloured status pill
 * competing with it.
 *
 * Renders nothing for a VM no sync tracks - an em dash there would imply the
 * answer is "unknown" when the real answer is "not applicable". */
export function PowerBadge({
  state,
  className,
}: {
  state?: string | null
  className?: string
}) {
  if (!state) return null
  const Icon =
    state === "running" ? Power : state === "suspended" ? Pause : PowerOff
  const label =
    state === "running"
      ? "Powered on"
      : state === "stopped"
        ? "Powered off"
        : state.charAt(0).toUpperCase() + state.slice(1)
  return (
    <Badge
      variant="outline"
      className={`gap-1 text-[10px] ${
        state === "running" ? "" : "text-muted-foreground"
      } ${className ?? ""}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  )
}
