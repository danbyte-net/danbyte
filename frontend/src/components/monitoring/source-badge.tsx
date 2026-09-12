import type { CheckSource, EngineRef } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"

/** Who answered: the core's workers, an Outpost by name, or a driver such
 * as Zabbix. One word rather than the engine's own name for local and
 * driver sources, so an estate with twelve Outposts still reads as three
 * kinds of source in a facet. */
export function SourceBadge({
  source,
  engine,
}: {
  source: CheckSource
  engine?: EngineRef | null
}) {
  const label =
    source === "local"
      ? "Local"
      : source === "outpost"
        ? (engine?.name ?? "Outpost")
        : source.charAt(0).toUpperCase() + source.slice(1)
  return (
    <Badge variant="outline" className="text-[10px]">
      {label}
    </Badge>
  )
}

/** The column header, with the one caveat a reader needs: rows from before
 * attribution existed carry no engine and show as Local. */
export function SourceHeader() {
  return (
    <span className="inline-flex items-center gap-1">
      Source
      <InfoTip>
        Who ran the check: Danbyte&apos;s own workers, an Outpost, or Zabbix.
        Results recorded before this was tracked show as Local.
      </InfoTip>
    </span>
  )
}
