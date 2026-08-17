import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import {
  api,
  type Paginated,
  type VMInterface,
  type VirtNetwork,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/** VM-centric slice of the network topology: this VM's interfaces → the
 * networks (VLANs) they're on → the virtual switch each rides. A VM on several
 * networks simply shows one connection per interface (multi-homing). */
export function VmTopologyCard({ vmId }: { vmId: string }) {
  const ifaces = useQuery({
    queryKey: ["vm-interfaces", vmId],
    queryFn: () =>
      api<Paginated<VMInterface>>(`/api/vm-interfaces/?vm=${vmId}`),
  })
  const nets = useQuery({
    queryKey: ["virt-networks", "all"],
    queryFn: () => api<Paginated<VirtNetwork>>("/api/virt-networks/"),
  })

  const netByVlan = new Map(
    (nets.data?.results ?? []).filter((n) => n.vlan).map((n) => [n.vlan!.id, n])
  )
  const conns = (ifaces.data?.results ?? [])
    .filter((i) => i.vlan)
    .map((i) => ({ iface: i, net: netByVlan.get(i.vlan!.id) ?? null }))

  if (ifaces.isLoading || nets.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (conns.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This VM isn't on a mapped virtual network yet. Enable{" "}
        <span className="font-medium">virtual switches &amp; networks</span>{" "}
        sync on its source to populate this.
      </p>
    )

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Network topology
      </h2>
      <div className="space-y-2">
        {conns.map(({ iface, net }) => (
          <div
            key={iface.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
          >
            <span className="font-mono text-xs">{iface.name}</span>
            <span className="text-muted-foreground">→</span>
            {iface.vlan ? (
              <Link
                to="/vlans/$id"
                params={{ id: iface.vlan.id }}
                className="link rounded-md border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs"
              >
                {net?.name ?? iface.vlan.name} · VLAN {iface.vlan.vlan_id}
              </Link>
            ) : null}
            {net?.vswitch ? (
              <>
                <span className="text-muted-foreground">on</span>
                <Link
                  to="/virtual-switches/$id"
                  params={{ id: net.vswitch }}
                  className="link text-xs"
                >
                  {net.vswitch_name ?? "switch"}
                </Link>
              </>
            ) : (
              <Badge variant="secondary" className="text-[10px]">
                no switch mapped
              </Badge>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
