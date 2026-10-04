import { Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"

import type {
  LinkCapacity,
  LinkCapacitySource,
  SiteMapCable,
  SiteMapCapacity,
  SiteMapLink,
  SiteMapLinkEnd,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { CopyButton } from "@/components/kv-card"
import { PanelRow, PanelSection } from "@/components/map-panel"
import { Badge } from "@/components/ui/badge"
import { fmtKbps } from "@/lib/speed"
import { useCableTypeLabel } from "@/lib/use-dcim-choices"

// What a line on the site map is made of (#246): its speed and where that
// figure comes from, the circuit's provider or the tunnel's encapsulation,
// and the ports at each end with their speeds - one link's ends, or a
// bundle's links. The line's popover and its inspector both show it, so the
// two can't drift apart again.

/** Where a line's speed comes from, after its figure: "10G · cable". */
const SOURCE_LABEL: Record<LinkCapacitySource, string> = {
  commit: "commit rate",
  port: "port speed",
  interface: "interfaces",
  override: "set on tunnel",
  cable: "cable",
  mixed: "mixed",
}

/** A source's words; one a newer server sends that this page doesn't know
 * reads as itself. */
export function sourceLabel(source: string): string {
  return source in SOURCE_LABEL
    ? SOURCE_LABEL[source as LinkCapacitySource]
    : source
}

/** "10G · cable", "500/100M · commit rate"; null when no speed is known. */
export function speedText(
  cap: Pick<LinkCapacity, "label" | "source"> | null | undefined
): string | null {
  if (!cap?.label) return null
  return `${cap.label} · ${sourceLabel(cap.source)}`
}

/** How many links a line carries and how many of those have no known
 * speed - null for a line of one link with a known speed. */
export function bundleText(
  capacity: SiteMapCapacity | null | undefined,
  linkCount: number | undefined
): string | null {
  const total = capacity
    ? capacity.count + capacity.unknown
    : Math.max(linkCount ?? 0, 0)
  const unknown = capacity ? capacity.unknown : 0
  if (total <= 1 && unknown === 0) return null
  return unknown > 0 ? `${total} links · ${unknown} unknown` : `${total} links`
}

/** What LinkFacts reads: a site map connection (a circuit, a tunnel, a site
 * pair's cables) or one cable. `capacity` is undefined until the map has
 * the capacity payload, and the speed rows wait for it. */
export interface FactsLine {
  kind: string
  name?: string
  meta?: Record<string, unknown>
  capacity?: SiteMapCapacity | null
  links?: SiteMapLink[]
  link_count?: number
}

/** The links a popover lists before "+N more"; the inspector lists every
 * one the map sent (the first 50). */
const COMPACT_LINKS = 3

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

/** A circuit end's own figures: its port speed, with the upstream speed
 * where it differs. */
function terminationSpeed(end: SiteMapLinkEnd): string {
  const t = end.termination
  return t ? fmtKbps(t.port_speed_kbps, { up: t.upstream_speed_kbps }) : ""
}

/** One end: what it lands on and the port, with its speed - or that you may
 * not see it. */
export function EndText({
  end,
  speeds = true,
}: {
  end: SiteMapLinkEnd
  /** Show the port's (or the termination's) speed after it. */
  speeds?: boolean
}) {
  // The port's own speed when it has one; a circuit end not cabled (or
  // cabled where you may not look) shows its termination's figures.
  const portSpeed =
    speeds && end.port ? fmtKbps(end.port.speed_kbps ?? null) : ""
  const speed = portSpeed || (speeds ? terminationSpeed(end) : "")
  const tail = speed ? (
    <span className="num text-muted-foreground"> · {speed}</span>
  ) : null
  if (end.restricted)
    return (
      <span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Lock className="size-3" />
          Restricted
        </span>
        {tail}
      </span>
    )
  const owner = end.device ? (
    <Link to="/devices/$id" params={{ id: end.device.id }} className="link">
      {end.device.name}
    </Link>
  ) : end.virtual_machine ? (
    <Link
      to="/virtual-machines/$id"
      params={{ id: end.virtual_machine.id }}
      className="link"
    >
      {end.virtual_machine.name}
    </Link>
  ) : end.port?.kind === "circuit_termination" ? (
    <Muted>Circuit</Muted>
  ) : null
  if (!owner && !end.port)
    return (
      <span>
        <Muted>{end.termination ? "Not cabled" : "-"}</Muted>
        {tail}
      </span>
    )
  return (
    <span>
      {owner}
      {owner && end.port && <Muted> · </Muted>}
      {end.port && <span className="font-mono">{end.port.name}</span>}
      {tail}
    </span>
  )
}

/**
 * A line's facts, in map-panel rows. `compact` is the popover's cut: the
 * first few links of a bundle, the rest counted.
 */
export function LinkFacts({
  line,
  compact = false,
}: {
  line: FactsLine
  compact?: boolean
}) {
  const meta = line.meta ?? {}
  const cap = line.capacity
  const links = line.links ?? []
  const count = Math.max(line.link_count ?? links.length, links.length)
  const bundle = cap === undefined ? null : bundleText(cap, count)
  const shown = compact ? links.slice(0, COMPACT_LINKS) : links
  const more = count - shown.length
  const single = count === 1 && links.length === 1 ? links[0] : null
  const str = (v: unknown) => (v == null || v === "" ? null : String(v))
  const provider = str(meta.provider)
  const type = str(meta.type)
  const encapsulation = str(meta.encapsulation)
  const group = str(meta.group)
  const cables = str(meta.count)
  return (
    <div data-slot="link-facts" className="text-[12px]">
      {cap !== undefined && (
        <PanelRow label="Speed">
          {cap?.label ? (
            <span className="num">
              {cap.label}
              <Muted> · {sourceLabel(cap.source)}</Muted>
            </span>
          ) : (
            <Muted>Unknown</Muted>
          )}
        </PanelRow>
      )}
      {bundle && (
        <PanelRow label="Bundle">
          <span className="num">{bundle}</span>
        </PanelRow>
      )}
      {line.kind === "circuit" && (
        <>
          {provider && <PanelRow label="Provider">{provider}</PanelRow>}
          {line.name && (
            <PanelRow label="Circuit ID">
              <span className="inline-flex items-baseline gap-1">
                <span className="font-mono">{line.name}</span>
                <CopyButton value={line.name} />
              </span>
            </PanelRow>
          )}
          {type && <PanelRow label="Type">{type}</PanelRow>}
        </>
      )}
      {line.kind === "tunnel" && (
        <>
          {encapsulation && (
            <PanelRow label="Encapsulation">
              <span className="font-mono">{encapsulation}</span>
            </PanelRow>
          )}
          {group && <PanelRow label="Group">{group}</PanelRow>}
        </>
      )}
      {line.kind === "cable" && cables && (
        <PanelRow label="Cables">
          <span className="num">{cables}</span>
        </PanelRow>
      )}
      {single && (
        <PanelSection label="Ends">
          <PanelRow label="A">
            <EndText end={single.a} />
          </PanelRow>
          <PanelRow label="Z">
            <EndText end={single.z} />
          </PanelRow>
        </PanelSection>
      )}
      {!single && shown.length > 0 && (
        <PanelSection label="Links">
          {shown.map((l, i) => (
            <PanelRow
              key={`${l.cable_id ?? ""}:${l.a.port?.id ?? i}:${l.z.port?.id ?? i}`}
              label={l.capacity?.label || "Unknown"}
            >
              <span className="grid">
                <EndText end={l.a} speeds={false} />
                <EndText end={l.z} speeds={false} />
              </span>
            </PanelRow>
          ))}
          {more > 0 && (
            <p className="pt-0.5 text-right text-[11px] text-muted-foreground">
              +<span className="num">{more}</span> more
            </p>
          )}
        </PanelSection>
      )}
    </div>
  )
}

/** Whether a cable's own ends tell more than its links do: it carries no
 * link, several, or its one link runs on through patch panels to other
 * ports. A plain port-to-port cable's one link IS its ends. */
export function showCableEnds(c: SiteMapCable): boolean {
  const links = c.links ?? []
  if (links.length !== 1 || (c.link_count ?? 1) !== 1) return true
  const [l] = links
  const at = (e: SiteMapLinkEnd, end: SiteMapCable["a"]) =>
    e.device?.id === end.device_id && e.port?.name === end.port
  return !((at(l.a, c.a) && at(l.z, c.z)) || (at(l.a, c.z) && at(l.z, c.a)))
}

/** One cable's type, status and strands, and - when they differ from its
 * links' - the ports it plugs into. Its popover and inspector open with
 * this, then its LinkFacts. */
export function CableSummary({ cable: c }: { cable: SiteMapCable }) {
  const typeLabel = useCableTypeLabel()
  const strands = c.fiber_count ?? 0
  return (
    <>
      {(c.type || c.status || strands > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {c.type && <Badge variant="outline">{typeLabel(c.type)}</Badge>}
          {c.status && (
            <ColorBadge
              name={c.status.name}
              color={c.status.color || undefined}
            />
          )}
          {strands > 0 && (
            <Badge variant="outline">
              <span className="num">{strands}</span>{" "}
              {strands === 1 ? "strand" : "strands"}
            </Badge>
          )}
        </div>
      )}
      {showCableEnds(c) && (
        <div className="text-[12px] text-muted-foreground">
          <Link
            to="/devices/$id"
            params={{ id: c.a.device_id }}
            className="link"
          >
            {c.a.device_name}
          </Link>
          <span className="font-mono">:{c.a.port}</span>
          {" ↔ "}
          <Link
            to="/devices/$id"
            params={{ id: c.z.device_id }}
            className="link"
          >
            {c.z.device_name}
          </Link>
          <span className="font-mono">:{c.z.port}</span>
        </div>
      )}
    </>
  )
}
