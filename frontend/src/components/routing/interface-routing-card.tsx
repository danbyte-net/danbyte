import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useState } from "react"

import { api } from "@/lib/api"
import type {
  BGPSession,
  EIGRPInstance,
  EthernetSegment,
  ISISInstance,
  OSPFInstance,
  Paginated,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { segmentIdentity } from "@/components/columns/routing-columns"

import {
  EIGRPInterfaceForm,
  ISISInterfaceForm,
  OSPFInterfaceForm,
} from "./igp-forms"

// What routes over this port: the OSPF, IS-IS and EIGRP instances it is
// enrolled in, the unnumbered BGP sessions on it, and the EVPN Ethernet
// segment it is a member of. Reads the device's instances (the same
// queries the Routing tab makes), so a row shows its instance and the
// instance's defaults. Every instance the port is not in yet is an Enrol
// button, so a port joins a process from its own page. Draws nothing while
// the device runs no routing at all.

export function InterfaceRoutingCard({
  interfaceId,
  deviceId,
  evpnMhUplink,
}: {
  interfaceId: string
  deviceId: string
  /** The port faces the multihomed fabric's uplinks, not a server. */
  evpnMhUplink?: boolean
}) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [enrol, setEnrol] = useState<
    | { kind: "ospf"; instance: OSPFInstance }
    | { kind: "isis"; instance: ISISInstance }
    | { kind: "eigrp"; instance: EIGRPInstance }
    | null
  >(null)
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
  const segments = useQuery({
    queryKey: ["ethernet-segments", "interface", interfaceId],
    queryFn: () =>
      api<Paginated<EthernetSegment>>(
        `/api/routing/ethernet-segments/?interface=${interfaceId}`
      ),
  })
  const es = segments.data?.results ?? []
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
  const notIn = (inst: { interfaces: { interface: { id: string } }[] }) =>
    !inst.interfaces.some((row) => row.interface.id === interfaceId)
  const joinable = [
    ...(canDo("ospfinterface", "add")
      ? (ospf.data?.results ?? []).filter(notIn).map((instance) => ({
          kind: "ospf" as const,
          instance,
          label: `OSPF ${instance.process_id}`.trim(),
        }))
      : []),
    ...(canDo("isisinterface", "add")
      ? (isis.data?.results ?? []).filter(notIn).map((instance) => ({
          kind: "isis" as const,
          instance,
          label: `IS-IS ${instance.process || instance.net}`,
        }))
      : []),
    ...(canDo("eigrpinterface", "add")
      ? (eigrp.data?.results ?? []).filter(notIn).map((instance) => ({
          kind: "eigrp" as const,
          instance,
          label: `EIGRP ${instance.asn}`,
        }))
      : []),
  ]
  if (
    o.length +
      i.length +
      e.length +
      b.length +
      es.length +
      joinable.length +
      (evpnMhUplink ? 1 : 0) ===
    0
  )
    return null
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ospf-instances"] })
    qc.invalidateQueries({ queryKey: ["isis-instances"] })
    qc.invalidateQueries({ queryKey: ["eigrp-instances"] })
    setEnrol(null)
  }

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
    ...es.map<KvRow>((seg) => ({
      label: "Ethernet segment",
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/ethernet-segments/$id"
            params={{ id: seg.id }}
            className="link font-mono"
          >
            {seg.name}
          </Link>
          {segmentIdentity(seg) && (
            <span className="font-mono text-muted-foreground">
              {segmentIdentity(seg)}
            </span>
          )}
        </span>
      ),
    })),
    ...(evpnMhUplink ? [{ label: "EVPN MH uplink", value: "Yes" }] : []),
  ]
  if (joinable.length > 0) {
    rows.push({
      label: "Enrol in",
      value: (
        <span className="flex flex-wrap gap-1">
          {joinable.map((j) => (
            <Button
              key={j.instance.id}
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() =>
                setEnrol({ kind: j.kind, instance: j.instance } as typeof enrol)
              }
            >
              <Plus className="h-3 w-3" /> {j.label}
            </Button>
          ))}
        </span>
      ),
    })
  }
  return (
    <>
      <KvCard title="Routing" rows={rows} />
      <Dialog open={enrol !== null} onOpenChange={(o) => !o && setEnrol(null)}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {enrol?.kind === "ospf"
                ? `Enrol in OSPF ${enrol.instance.process_id}`.trim()
                : enrol?.kind === "isis"
                  ? `Enrol in IS-IS ${enrol.instance.process || enrol.instance.net}`
                  : enrol?.kind === "eigrp"
                    ? `Enrol in EIGRP ${enrol.instance.asn}`
                    : ""}
            </DialogTitle>
          </DialogHeader>
          {enrol?.kind === "ospf" && (
            <OSPFInterfaceForm
              instance={enrol.instance}
              initialInterfaceId={interfaceId}
              onSaved={refresh}
              onCancel={() => setEnrol(null)}
            />
          )}
          {enrol?.kind === "isis" && (
            <ISISInterfaceForm
              instance={enrol.instance}
              initialInterfaceId={interfaceId}
              onSaved={refresh}
              onCancel={() => setEnrol(null)}
            />
          )}
          {enrol?.kind === "eigrp" && (
            <EIGRPInterfaceForm
              instance={enrol.instance}
              initialInterfaceId={interfaceId}
              onSaved={refresh}
              onCancel={() => setEnrol(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
