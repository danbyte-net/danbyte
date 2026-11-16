import type { MonitoringEngine } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"

/** Whether an Outpost's agent said it runs as root (agent 0.10+). */
export function runsAsRoot(engine: MonitoringEngine | null | undefined) {
  return engine?.agent_capabilities?.runtime?.root === true
}

/**
 * A warning chip for an Outpost whose agent runs as root: it works, but nmap
 * stays off and the agent has more access than it needs. Nothing renders
 * for an agent that runs unprivileged or is too old to say.
 */
export function OutpostRootBadge({
  engine,
}: {
  engine: MonitoringEngine | null | undefined
}) {
  if (!runsAsRoot(engine)) return null
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="warning" className="text-[10px]">
        root
      </Badge>
      <InfoTip>
        The agent runs as root, so nmap is off. On the Outpost host run{" "}
        <code className="font-mono">
          sudo /opt/danbyte-outpost/danbyte-outpost migrate-service-user
        </code>{" "}
        or re-run the installer.
      </InfoTip>
    </span>
  )
}
