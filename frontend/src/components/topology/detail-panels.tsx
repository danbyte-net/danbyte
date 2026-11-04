import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowUpRight, Crosshair } from "lucide-react"

import { api } from "@/lib/api"
import type {
  BulkStatusResponse,
  CheckStatus,
  TopoEdge,
  TopoNode,
  TopoProviderNetworkData,
} from "@/lib/api"
import { fmtKbps } from "@/lib/speed"
import { useCableTypeLabel } from "@/lib/use-dcim-choices"
import { ColorBadge } from "@/components/cells/color-badge"
import { StatusBadge } from "@/components/status-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { BarButton } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import { Button } from "@/components/ui/button"

import type { BundleMember } from "./edge-semantics"
import type { GroupEdgeInfo, TopoGroupData } from "./group-node"
import { sharedLag } from "./lag-bundles"
import { isProviderNetwork } from "./provider-network-node"

// The panels the topology map opens over its canvas: one for a device, a
// cable, a bundle of parallel cables, a site or location card, the line
// between two such cards, and a provider network and a circuit to it
// (#466). All are the shared map PanelShell.

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/** A device's monitoring roll-up: from the map's own bulk query when it has
 * run, else fetched for this one device. `null` = no checks. */
function useDeviceCheck(
  deviceId: string | undefined,
  known: CheckStatus | null | undefined
): CheckStatus | null {
  const q = useQuery({
    queryKey: ["device-mon-status", deviceId ? [deviceId] : []],
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ devices: [deviceId] }),
      }),
    enabled: !!deviceId && known === undefined,
    staleTime: 30_000,
  })
  if (known !== undefined) return known
  return (deviceId && q.data?.statuses[deviceId]?.status) || null
}

interface NodePanelProps {
  data: TopoNode["data"]
  /** The device's check roll-up when the map already has it (`null` = no
   * checks); left out, the panel asks for it. */
  monitor?: CheckStatus | null
  onClose: () => void
  onFocus: (deviceId: string) => void
}

/** A card's panel: a device's, or a provider network's (#466). */
export function NodePanel(props: NodePanelProps) {
  if (isProviderNetwork(props.data))
    return <ProviderNetworkPanel data={props.data} onClose={props.onClose} />
  return <DevicePanel {...props} />
}

function DevicePanel({ data: d, monitor, onClose, onFocus }: NodePanelProps) {
  const check = useDeviceCheck(d.device_id, monitor)
  return (
    <PanelShell
      label="Device"
      title={d.name}
      onClose={onClose}
      footer={
        d.device_id && (
          <>
            <OpenLink to="/devices/$id" params={{ id: d.device_id }}>
              Open device
            </OpenLink>
            <BarButton onClick={() => onFocus(d.device_id!)}>
              <Crosshair /> Focus
            </BarButton>
          </>
        )
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
      {check && (
        <PanelRow label="Monitoring">
          <CheckStatusBadge status={check} />
        </PanelRow>
      )}
      {d.device_type && <PanelRow label="Type">{d.device_type}</PanelRow>}
      {d.site && (
        <PanelRow label="Site">
          {d.location ? `${d.site} · ${d.location}` : d.site}
        </PanelRow>
      )}
      {d.primary_ip && (
        <PanelRow label="IP">
          <span className="font-mono">{d.primary_ip}</span>
        </PanelRow>
      )}
      <PanelRow label="Cabled">
        <span className="num">
          {d.ports?.length ?? 0} / {d.interface_count ?? 0}
        </span>
      </PanelRow>
    </PanelShell>
  )
}

type CablePairRow = NonNullable<NonNullable<TopoEdge["data"]>["pairs"]>[number]

/** One cable pair: each end's port and every address it has, and the
 * subnets the two ends share. Full names, wrapped - never clipped. */
function PairEnds({ pair: p }: { pair: CablePairRow }) {
  const subnets = (p.subnets ?? []).map((s) => s.cidr)
  const label = "font-sans text-[11px] text-muted-foreground"
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2 py-1 font-mono text-[11px] leading-snug">
      {(["a", "b"] as const).map((end) => (
        <div key={end} className="contents">
          <span className={label}>{end.toUpperCase()}</span>
          <div className="min-w-0 break-all">
            <div>{end === "a" ? p.a : p.b}</div>
            {((end === "a" ? p.a_ips : p.b_ips) ?? []).map((ip) => (
              <div key={ip} className="text-muted-foreground">
                {ip}
              </div>
            ))}
          </div>
        </div>
      ))}
      {subnets.length > 0 && (
        <>
          <span className={label}>Subnet</span>
          <div className="min-w-0 break-all">
            {subnets.map((cidr) => (
              <div key={cidr}>{cidr}</div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** "Cable #12", or the cable's own label. */
function cableName(c: { cable_label?: string; cable_numid?: number | null }) {
  return c.cable_label || (c.cable_numid ? `Cable #${c.cable_numid}` : "Cable")
}

interface EdgePanelProps {
  data: NonNullable<TopoEdge["data"]>
  onClose: () => void
  /** The Diagram link's Line row. */
  line?: React.ReactNode
}

/** A line's panel: a cable's, or a circuit's to a provider network
 * (#466). */
export function EdgePanel(props: EdgePanelProps) {
  if (props.data.circuit) return <CircuitPanel {...props} />
  return <CablePanel {...props} />
}

/** A circuit to a provider network: the circuit, its provider and commit
 * rate, and the port its site end is cabled to. */
export function CircuitPanel({ data: d, onClose, line }: EdgePanelProps) {
  const c = d.circuit!
  const rate = fmtKbps(c.commit_rate_kbps, { long: true })
  return (
    <PanelShell
      label="Circuit"
      title={<span className="font-mono">{c.cid}</span>}
      titleText={c.cid}
      onClose={onClose}
      footer={
        <OpenLink to="/circuits/$id" params={{ id: c.id }}>
          Open circuit
        </OpenLink>
      }
    >
      <PanelRow label="Provider">{c.provider.name}</PanelRow>
      {c.type && (
        <PanelRow label="Type">
          <ColorBadge name={c.type.name} color={c.type.color || undefined} />
        </PanelRow>
      )}
      {c.status && (
        <PanelRow label="Status">
          <StatusBadge status={c.status} />
        </PanelRow>
      )}
      {rate && (
        <PanelRow label="Commit rate">
          <span className="num">{rate}</span>
        </PanelRow>
      )}
      {d.provider_network && (
        <PanelRow label="Network">
          <Link
            to="/provider-networks/$id"
            params={{ id: d.provider_network.id }}
            className="link"
          >
            {d.provider_network.name}
          </Link>
        </PanelRow>
      )}
      {d.ends?.length ? (
        // A circuit between two of your sites: each end's site and port.
        d.ends.map((end) => (
          <PanelSection key={end.side} label={`Side ${end.side}`}>
            <PanelRow label="Site">{end.site.name}</PanelRow>
            <PanelRow label="Port">
              <span className="font-mono">
                {end.device.name}:{end.port.name}
              </span>
            </PanelRow>
            {!!end.via.length && (
              <PanelRow label="Via">{end.via.join(", ")}</PanelRow>
            )}
          </PanelSection>
        ))
      ) : (
        <>
          {d.site && <PanelRow label="Site">{d.site.name}</PanelRow>}
          <PanelRow label="Port">
            {d.device && d.port ? (
              <span className="font-mono">
                {d.device.name}:{d.port.name}
              </span>
            ) : (
              <span className="text-muted-foreground">Not cabled</span>
            )}
          </PanelRow>
          {!!d.via?.length && (
            <PanelRow label="Via">{d.via.join(", ")}</PanelRow>
          )}
        </>
      )}
      {line && <PanelSection label="Line">{line}</PanelSection>}
    </PanelShell>
  )
}

/** A provider network: its provider and the circuits that meet at it. */
export function ProviderNetworkPanel({
  data: d,
  onClose,
}: {
  data: TopoProviderNetworkData
  onClose: () => void
}) {
  return (
    <PanelShell
      label="Provider network"
      title={d.name}
      onClose={onClose}
      footer={
        <OpenLink
          to="/provider-networks/$id"
          params={{ id: d.provider_network_id }}
        >
          Open provider network
        </OpenLink>
      }
    >
      <PanelRow label="Provider">{d.provider.name}</PanelRow>
      {d.service_id && (
        <PanelRow label="Service ID">
          <span className="font-mono">{d.service_id}</span>
        </PanelRow>
      )}
      <PanelSection label={`Circuits · ${d.circuits.length}`}>
        <div className="divide-y divide-border">
          {d.circuits.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-1">
              <Link
                to="/circuits/$id"
                params={{ id: c.id }}
                className="link min-w-0 truncate font-mono"
              >
                {c.cid}
              </Link>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {c.site?.name}
              </span>
              {c.status && <StatusBadge status={c.status} />}
            </div>
          ))}
        </div>
      </PanelSection>
    </PanelShell>
  )
}

function CablePanel({ data: d, onClose, line }: EdgePanelProps) {
  const typeLabel = useCableTypeLabel()
  return (
    <PanelShell
      label="Cable"
      title={
        d.cable_label || !d.cable_numid ? (
          cableName(d)
        ) : (
          <>
            Cable <span className="font-mono">#{d.cable_numid}</span>
          </>
        )
      }
      titleText={cableName(d)}
      onClose={onClose}
      footer={
        d.cable_id && (
          <OpenLink to="/cables/$id" params={{ id: d.cable_id }}>
            Open cable
          </OpenLink>
        )
      }
    >
      {d.cable_type && (
        <PanelRow label="Type">{typeLabel(d.cable_type)}</PanelRow>
      )}
      {d.status_mini && (
        <PanelRow label="Status">
          <StatusBadge status={d.status_mini} />
        </PanelRow>
      )}
      {d.length && (
        <PanelRow label="Length">
          <span className="num">
            {d.length} {d.length_unit}
          </span>
        </PanelRow>
      )}
      {d.speed && (
        <PanelRow label="Speed">
          <span className="font-mono">{d.speed}</span>
        </PanelRow>
      )}
      {!!d.via?.length && <PanelRow label="Via">{d.via.join(", ")}</PanelRow>}
      {line && <PanelSection label="Line">{line}</PanelSection>}
      {!!d.pairs?.length && (
        <PanelSection label="Ports">
          <div className="divide-y divide-border">
            {d.pairs.map((p, i) => (
              <PairEnds key={i} pair={p} />
            ))}
          </div>
        </PanelSection>
      )}
    </PanelShell>
  )
}

/** A pair end's device: the port-qualified name ("sw1:Gi0/1") less its
 * port. */
function deviceOf(end: string, port: string | undefined): string {
  if (port && end.endsWith(`:${port}`))
    return end.slice(0, end.length - port.length - 1)
  const i = end.lastIndexOf(":")
  return i > 0 ? end.slice(0, i) : end
}

/** What a bundle joins: the two aggregates ("Po1 ⇄ Po10", mono) when every
 * cable shares them, else the two devices ("sw1 ↔ sw2"). */
function bundleEnds(
  cables: BundleMember[]
): { text: string; node: React.ReactNode } | null {
  const lag = sharedLag(cables)
  if (lag?.a && lag.b) {
    const text = `${lag.a.name} ⇄ ${lag.b.name}`
    return { text, node: <span className="font-mono">{text}</span> }
  }
  const p = cables.find((c) => c.pairs?.length)?.pairs?.[0]
  if (!p) return null
  const text = `${deviceOf(p.a, p.a_port)} ↔ ${deviceOf(p.b, p.b_port)}`
  return { text, node: text }
}

export function BundlePanel({
  cables,
  onClose,
  line,
}: {
  cables: BundleMember[]
  onClose: () => void
  /** The Diagram link's Line row. */
  line?: React.ReactNode
}) {
  const typeLabel = useCableTypeLabel()
  const ends = bundleEnds(cables)
  const count = plural(cables.length, "cable")
  return (
    <PanelShell
      label="Cables"
      title={
        ends ? (
          <>
            {ends.node} · {count}
          </>
        ) : (
          count
        )
      }
      titleText={ends ? `${ends.text} · ${count}` : count}
      onClose={onClose}
    >
      {line && <PanelSection label="Line">{line}</PanelSection>}
      <PanelSection label="Cables">
        <div className="divide-y divide-border">
          {cables.map((c, i) => {
            const meta = [c.cable_type && typeLabel(c.cable_type), c.speed]
              .filter(Boolean)
              .join(" · ")
            return (
              <div key={c.cable_id ?? i} className="py-1.5 first:pt-0">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {cableName(c)}
                  </span>
                  {c.status_mini && <StatusBadge status={c.status_mini} />}
                  {c.cable_id && (
                    <Button
                      asChild
                      size="xs"
                      variant="outline"
                      className="shrink-0"
                    >
                      <Link
                        to="/cables/$id"
                        params={{ id: c.cable_id }}
                        aria-label={`Open ${cableName(c)}`}
                      >
                        <ArrowUpRight /> Open
                      </Link>
                    </Button>
                  )}
                </div>
                {meta && <div className="text-muted-foreground">{meta}</div>}
                {c.pairs?.map((p, j) => (
                  <PairEnds key={j} pair={p} />
                ))}
              </div>
            )
          })}
        </div>
      </PanelSection>
    </PanelShell>
  )
}

/** Grouped map: a site or location card's summary, and the way in. */
export function GroupPanel({
  data: d,
  onClose,
  onDrill,
}: {
  data: TopoGroupData
  onClose: () => void
  onDrill: (d: TopoGroupData) => void
}) {
  return (
    <PanelShell
      label={d.kind === "location" ? "Location" : "Site"}
      title={d.name}
      onClose={onClose}
      footer={
        // Drilling in stays on the map, so no "leave the page" arrow.
        d.group_id && (
          <BarButton onClick={() => onDrill(d)}>Open group</BarButton>
        )
      }
    >
      <PanelRow label="Grouped by">
        {d.kind === "location" ? "Location" : "Site"}
      </PanelRow>
      <PanelRow label="Devices">
        <span className="num">{d.device_count}</span>
      </PanelRow>
      {d.roles.length > 0 && (
        <PanelSection label="Roles">
          {d.roles.map((r) => (
            <div key={r.name} className="flex items-center gap-2 py-0.5">
              <ColorBadge
                name={r.name}
                color={r.color || undefined}
                // A block truncates with an ellipsis; the flex badge clips.
                className="block min-w-0 truncate"
              />
              <span className="num ml-auto text-muted-foreground">
                {r.count}
              </span>
            </div>
          ))}
        </PanelSection>
      )}
    </PanelShell>
  )
}

/** Grouped map: the cables between two site or location cards. */
export function GroupEdgePanel({
  data: d,
  onClose,
}: {
  data: GroupEdgeInfo
  onClose: () => void
}) {
  const typeLabel = useCableTypeLabel()
  return (
    <PanelShell
      label="Cables between groups"
      title={plural(d.cable_count, "cable")}
      onClose={onClose}
    >
      <PanelSection label="Cable types">
        {d.types.length > 0 ? (
          d.types.map((t) => (
            <div key={t} className="py-0.5">
              {typeLabel(t)}
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">No cable types</p>
        )}
      </PanelSection>
    </PanelShell>
  )
}
