import { Link } from "@tanstack/react-router"
import { Crosshair } from "lucide-react"

import type {
  RoutingBgpData,
  RoutingCableData,
  RoutingEdge,
  RoutingNode,
  RoutingProcess,
  RoutingRef,
  RoutingRouterData,
  RoutingSessionRow,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { StatusBadge } from "@/components/status-badge"
import { BarButton } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import { Badge } from "@/components/ui/badge"
import { CircuitPanel, ProviderNetworkPanel } from "../detail-panels"
import { afShort } from "./routing-model"

// The Routing tab's panels, in the shared map PanelShell: a router's
// (router ID, ASes, loopback, the processes it runs) and a line's - for a
// BGP line every session on it with its peer group, policies in and out
// (each a link to the policy), max-prefix, BFD, the timers and the
// instance's RPKI caches; a circuit's and a provider network's as on the
// Diagram; a cable line's cables.

const PROCESS: Record<RoutingProcess["kind"], string> = {
  bgp: "BGP",
  ospf: "OSPF",
  isis: "IS-IS",
  eigrp: "EIGRP",
  ldp: "LDP",
  static: "Static",
}

const asText = (n: number | null) => (n === null ? "AS?" : `AS${n}`)

/** A process as one line: "BGP AS65001", "OSPF · VRF red", "Static · 12". */
function processText(p: RoutingProcess): string {
  const parts = [PROCESS[p.kind]]
  if (p.kind === "bgp" && p.asn !== undefined) parts[0] += ` AS${p.asn}`
  if (p.kind === "static" && p.count) parts.push(`${p.count}`)
  if (p.vrf) parts.push(`VRF ${p.vrf}`)
  return parts.join(" · ")
}

export function RoutingNodePanel({
  node,
  onClose,
  onFocus,
}: {
  node: RoutingNode
  onClose: () => void
  onFocus: (deviceId: string) => void
}) {
  if (node.type !== "router")
    return <ProviderNetworkPanel data={node.data} onClose={onClose} />
  return <RouterPanel data={node.data} onClose={onClose} onFocus={onFocus} />
}

function RouterPanel({
  data: d,
  onClose,
  onFocus,
}: {
  data: RoutingRouterData
  onClose: () => void
  onFocus: (deviceId: string) => void
}) {
  return (
    <PanelShell
      label="Router"
      title={d.name}
      onClose={onClose}
      footer={
        d.device_id ? (
          <>
            <OpenLink to="/devices/$id" params={{ id: d.device_id }}>
              Open device
            </OpenLink>
            <BarButton onClick={() => onFocus(d.device_id!)}>
              <Crosshair /> Focus
            </BarButton>
          </>
        ) : d.vm_id ? (
          <OpenLink to="/virtual-machines/$id" params={{ id: d.vm_id }}>
            Open VM
          </OpenLink>
        ) : undefined
      }
    >
      {d.role && (
        <PanelRow label="Role">
          <ColorBadge name={d.role.name} color={d.role.color || undefined} />
        </PanelRow>
      )}
      {d.status_mini && (
        <PanelRow label="Status">
          <StatusBadge status={d.status_mini} />
        </PanelRow>
      )}
      {d.site && <PanelRow label="Site">{d.site}</PanelRow>}
      {d.router_id && (
        <PanelRow label="Router ID">
          <span className="font-mono">{d.router_id}</span>
        </PanelRow>
      )}
      {d.asns.length > 0 && (
        <PanelRow label="ASN">
          {d.asns
            .map((a) => (a.vrf ? `AS${a.asn} (${a.vrf})` : `AS${a.asn}`))
            .join(", ")}
        </PanelRow>
      )}
      {d.loopback && (
        <PanelRow label="Loopback">
          <span className="font-mono">{d.loopback}</span>
        </PanelRow>
      )}
      {d.primary_ip && (
        <PanelRow label="IP">
          <span className="font-mono">{d.primary_ip}</span>
        </PanelRow>
      )}
      <PanelSection label="Routing">
        {d.instances.length ? (
          <ul className="space-y-0.5">
            {d.instances.map((p, i) => (
              <li key={p.id ?? `${p.kind}${i}`}>{processText(p)}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No routing process</p>
        )}
      </PanelSection>
    </PanelShell>
  )
}

export function RoutingEdgePanel({
  edge,
  name,
  onClose,
}: {
  edge: RoutingEdge
  /** A node's name, by id. */
  name: (id: string) => string
  onClose: () => void
}) {
  if (edge.type === "circuit")
    return <CircuitPanel data={edge.data} onClose={onClose} />
  if (edge.type === "cable")
    return (
      <CableLinePanel
        data={edge.data}
        title={`${name(edge.source)} ⇄ ${name(edge.target)}`}
        onClose={onClose}
      />
    )
  return (
    <BgpLinePanel
      kind={edge.type}
      data={edge.data}
      source={name(edge.source)}
      target={name(edge.target)}
      name={name}
      onClose={onClose}
    />
  )
}

function PolicyLink({ to }: { to: RoutingRef | null }) {
  if (!to) return <span className="text-muted-foreground">-</span>
  return (
    <Link to="/routing-policies/$id" params={{ id: to.id }} className="link">
      {to.name}
    </Link>
  )
}

function BgpLinePanel({
  kind,
  data: d,
  source,
  target,
  name,
  onClose,
}: {
  kind: "ebgp" | "ibgp"
  data: RoutingBgpData
  source: string
  target: string
  name: (id: string) => string
  onClose: () => void
}) {
  const first = d.sessions.at(0)
  return (
    <PanelShell
      label="BGP"
      title={`${source} ⇄ ${target}`}
      onClose={onClose}
      footer={
        first && (
          <OpenLink to="/bgp-sessions/$id" params={{ id: first.id }}>
            Open session
          </OpenLink>
        )
      }
    >
      <PanelRow label="Kind">{kind === "ebgp" ? "eBGP" : "iBGP"}</PanelRow>
      <PanelRow label="ASes">
        {asText(d.a_asn)} ⇄ {asText(d.b_asn)}
      </PanelRow>
      {d.address_families.length > 0 && (
        <PanelRow label="Families">
          {d.address_families.map(afShort).join(", ")}
        </PanelRow>
      )}
      {d.vrf && <PanelRow label="VRF">{d.vrf}</PanelRow>}
      {d.rr && (
        <PanelRow label="Route reflector">
          {name(d.rr.reflector)} → {name(d.rr.client)}
          {d.rr.cluster_id ? ` · cluster ${d.rr.cluster_id}` : ""}
        </PanelRow>
      )}
      {d.one_sided && (
        <PanelRow label="Defined">
          <Badge variant="warning">One side only</Badge>
        </PanelRow>
      )}
      {d.sessions.map((s) => (
        <SessionSection key={s.id} s={s} owner={name(s.node)} />
      ))}
    </PanelShell>
  )
}

function SessionSection({ s, owner }: { s: RoutingSessionRow; owner: string }) {
  const far = s.remote_address ?? s.interface ?? "?"
  const perAf = s.address_families.filter(
    (af) =>
      af.import_policy?.id !== s.import_policy?.id ||
      af.export_policy?.id !== s.export_policy?.id ||
      (af.maximum_prefix ?? null) !== (s.maximum_prefix ?? null)
  )
  const timers =
    s.keepalive !== null || s.hold_time !== null
      ? `${s.keepalive ?? "-"} / ${s.hold_time ?? "-"} s`
      : null
  return (
    <PanelSection label={`${owner} → ${far}`}>
      <PanelRow label="Session">
        <Link to="/bgp-sessions/$id" params={{ id: s.id }} className="link">
          {s.name || far}
        </Link>
      </PanelRow>
      {s.status_mini && (
        <PanelRow label="Status">
          <StatusBadge status={s.status_mini} />
        </PanelRow>
      )}
      {s.peer_group && (
        <PanelRow label="Peer group">
          <Link
            to="/bgp-peer-groups/$id"
            params={{ id: s.peer_group.id }}
            className="link"
          >
            {s.peer_group.name}
          </Link>
        </PanelRow>
      )}
      <PanelRow label="Policy in">
        <PolicyLink to={s.import_policy} />
      </PanelRow>
      <PanelRow label="Policy out">
        <PolicyLink to={s.export_policy} />
      </PanelRow>
      {perAf.map((af) => (
        <PanelRow key={af.afi_safi} label={afShort(af.afi_safi)}>
          <PolicyLink to={af.import_policy} /> in ·{" "}
          <PolicyLink to={af.export_policy} /> out
          {af.maximum_prefix !== null && (
            <span className="num"> · max {af.maximum_prefix}</span>
          )}
        </PanelRow>
      ))}
      {s.maximum_prefix !== null && (
        <PanelRow label="Max prefixes">
          <span className="num">{s.maximum_prefix}</span>
        </PanelRow>
      )}
      <PanelRow label="BFD">
        {s.bfd ? (
          s.bfd_profile ? (
            <Link
              to="/bfd-profiles/$id"
              params={{ id: s.bfd_profile.id }}
              className="link"
            >
              {s.bfd_profile.name}
            </Link>
          ) : (
            "On"
          )
        ) : (
          "Off"
        )}
      </PanelRow>
      {timers && (
        <PanelRow label="Keepalive / hold">
          <span className="num">{timers}</span>
        </PanelRow>
      )}
      {s.route_reflector_client && (
        <PanelRow label="Client">Route reflector client</PanelRow>
      )}
      {s.rpki_caches.length > 0 && (
        <PanelRow label="RPKI">
          {s.rpki_caches.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <Link
                to="/rpki-caches/$id"
                params={{ id: c.id }}
                className="link"
              >
                {c.name}
              </Link>
            </span>
          ))}
        </PanelRow>
      )}
    </PanelSection>
  )
}

function CableLinePanel({
  data: d,
  title,
  onClose,
}: {
  data: RoutingCableData
  title: string
  onClose: () => void
}) {
  return (
    <PanelShell label="Cables" title={title} onClose={onClose}>
      <PanelSection label={`Cables · ${d.cables.length}`}>
        <div className="divide-y divide-border">
          {d.cables.map((c) => (
            <div key={c.id} className="py-1">
              <Link to="/cables/$id" params={{ id: c.id }} className="link">
                {c.label || (c.numid ? `Cable #${c.numid}` : "Cable")}
              </Link>
              <div className="font-mono text-[11px] break-all text-muted-foreground">
                {c.a} ⇄ {c.b}
              </div>
            </div>
          ))}
        </div>
      </PanelSection>
    </PanelShell>
  )
}
