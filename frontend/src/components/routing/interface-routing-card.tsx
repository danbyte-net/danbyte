import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type {
  BGPSession,
  ISISInterface,
  OSPFInterface,
  Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"

// What routes over this port: the OSPF and IS-IS instances it is enrolled
// in and the unnumbered BGP sessions on it. Reads from the rows' own
// endpoints, so the interface page needs nothing new on its serializer;
// draws nothing while the port carries no routing.

export function InterfaceRoutingCard({
  interfaceId,
  deviceId,
}: {
  interfaceId: string
  deviceId: string
}) {
  const ospf = useQuery({
    queryKey: ["ospf-interfaces", "iface", interfaceId],
    queryFn: () =>
      api<Paginated<OSPFInterface & { instance_id?: string }>>(
        `/api/routing/ospf-interfaces/?interface=${interfaceId}`
      ),
  })
  const isis = useQuery({
    queryKey: ["isis-interfaces", "iface", interfaceId],
    queryFn: () =>
      api<Paginated<ISISInterface>>(
        `/api/routing/isis-interfaces/?interface=${interfaceId}`
      ),
  })
  const bgp = useQuery({
    queryKey: ["bgp-sessions", "iface", interfaceId, deviceId],
    queryFn: () =>
      api<Paginated<BGPSession>>(
        `/api/routing/bgp-sessions/?device=${deviceId}&page_size=200`
      ),
  })
  const o = ospf.data?.results ?? []
  const i = isis.data?.results ?? []
  const b = (bgp.data?.results ?? []).filter(
    (s) => s.interface?.id === interfaceId
  )
  if (o.length + i.length + b.length === 0) return null

  const rows: KvRow[] = [
    ...o.map<KvRow>((row) => ({
      label: "OSPF",
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/ospf-areas/$id"
            params={{ id: row.area.id }}
            className="link"
          >
            area {row.area.area_id}
          </Link>
          {row.cost != null && (
            <span className="text-muted-foreground">
              cost <span className="num">{row.cost}</span>
            </span>
          )}
          {row.network_type && (
            <span className="text-muted-foreground">{row.network_type}</span>
          )}
          {row.passive && <Badge variant="secondary">passive</Badge>}
        </span>
      ),
    })),
    ...i.map<KvRow>((row) => ({
      label: "IS-IS",
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{row.families.join(" ")}</span>
          {row.level && <Badge variant="secondary">L{row.level}</Badge>}
          {row.metric != null && (
            <span className="text-muted-foreground">
              metric <span className="num">{row.metric}</span>
            </span>
          )}
          {row.passive && <Badge variant="secondary">passive</Badge>}
        </span>
      ),
    })),
    ...b.map<KvRow>((s) => ({
      label: "BGP",
      value: (
        <Link
          to="/bgp-sessions/$id"
          params={{ id: s.id }}
          className="link font-mono"
        >
          unnumbered · AS{s.effective.local_asn} →{" "}
          {s.effective.remote_asn_mode === "asn"
            ? `AS${s.effective.remote_asn}`
            : s.effective.remote_asn_mode}
        </Link>
      ),
    })),
  ]
  return <KvCard title="Routing" rows={rows} />
}
