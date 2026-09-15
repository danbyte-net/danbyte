import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type {
  BGPSession,
  EIGRPInstance,
  ISISInstance,
  OSPFInstance,
  Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"

// What routes over this port: the OSPF and IS-IS instances it is enrolled
// in and the unnumbered BGP sessions on it. Reads the device's instances
// (the same queries the Routing tab makes), so a row shows its instance
// and the instance's defaults; draws nothing while the port carries no
// routing.

export function InterfaceRoutingCard({
  interfaceId,
  deviceId,
}: {
  interfaceId: string
  deviceId: string
}) {
  const ospf = useQuery({
    queryKey: ["ospf-instances", "device", deviceId],
    queryFn: () =>
      api<Paginated<OSPFInstance>>(
        `/api/routing/ospf-instances/?device=${deviceId}`
      ),
  })
  const isis = useQuery({
    queryKey: ["isis-instances", "device", deviceId],
    queryFn: () =>
      api<Paginated<ISISInstance>>(
        `/api/routing/isis-instances/?device=${deviceId}`
      ),
  })
  const eigrp = useQuery({
    queryKey: ["eigrp-instances", "device", deviceId],
    queryFn: () =>
      api<Paginated<EIGRPInstance>>(
        `/api/routing/eigrp-instances/?device=${deviceId}`
      ),
  })
  const bgp = useQuery({
    queryKey: ["bgp-sessions", "iface", interfaceId, deviceId],
    queryFn: () =>
      api<Paginated<BGPSession>>(
        `/api/routing/bgp-sessions/?device=${deviceId}&page_size=200`
      ),
  })
  const o = (ospf.data?.results ?? []).flatMap((inst) =>
    inst.interfaces
      .filter((row) => row.interface.id === interfaceId)
      .map((row) => ({ inst, row }))
  )
  const i = (isis.data?.results ?? []).flatMap((inst) =>
    inst.interfaces
      .filter((row) => row.interface.id === interfaceId)
      .map((row) => ({ inst, row }))
  )
  const e = (eigrp.data?.results ?? []).flatMap((inst) =>
    inst.interfaces
      .filter((row) => row.interface.id === interfaceId)
      .map((row) => ({ inst, row }))
  )
  const b = (bgp.data?.results ?? []).filter(
    (s) => s.interface?.id === interfaceId
  )
  if (o.length + i.length + e.length + b.length === 0) return null

  const rows: KvRow[] = [
    ...o.map<KvRow>(({ inst, row }) => ({
      label: "OSPF",
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/devices/$id"
            params={{ id: deviceId }}
            search={{ tab: "routing" }}
            className="link font-mono"
          >
            OSPF {inst.process_id}
          </Link>
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
          {(row.passive ?? inst.passive_by_default) && (
            <Badge variant="secondary">passive</Badge>
          )}
        </span>
      ),
    })),
    ...i.map<KvRow>(({ inst, row }) => ({
      label: "IS-IS",
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/devices/$id"
            params={{ id: deviceId }}
            search={{ tab: "routing" }}
            className="link font-mono"
          >
            IS-IS {inst.process || inst.net}
          </Link>
          <span className="font-mono text-muted-foreground">
            {(row.families.length ? row.families : ["ipv4"]).join(" ")}
          </span>
          <Badge variant="secondary">L{row.level || inst.level}</Badge>
          {row.metric != null && (
            <span className="text-muted-foreground">
              metric <span className="num">{row.metric}</span>
            </span>
          )}
          {row.network_type && (
            <span className="text-muted-foreground">{row.network_type}</span>
          )}
          {row.passive && <Badge variant="secondary">passive</Badge>}
        </span>
      ),
    })),
    ...e.map<KvRow>(({ inst, row }) => ({
      label: "EIGRP",
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/devices/$id"
            params={{ id: deviceId }}
            search={{ tab: "routing" }}
            className="link font-mono"
          >
            EIGRP {inst.name ? `${inst.name} · ` : ""}AS {inst.asn}
          </Link>
          {row.summary_addresses.length > 0 && (
            <span className="font-mono text-muted-foreground">
              summary {row.summary_addresses.join(", ")}
            </span>
          )}
          {(row.passive ?? inst.passive_by_default) && (
            <Badge variant="secondary">passive</Badge>
          )}
          {row.bfd && <Badge variant="secondary">bfd</Badge>}
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
          {s.effective.remote_asn_mode === "internal"
            ? `AS${s.effective.local_asn}`
            : s.effective.remote_asn_mode === "external"
              ? "an external AS"
              : `AS${s.effective.remote_asn}`}
        </Link>
      ),
    })),
  ]
  return <KvCard title="Routing" rows={rows} />
}
