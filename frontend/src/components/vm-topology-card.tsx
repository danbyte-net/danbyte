import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated, StatusMini, VMInterface, VirtNetwork } from "@/lib/api"
import type { RailModel } from "@/lib/diagram/rails"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { RailFrame } from "@/components/topology/rail-diagram"

// The Virtual topology's rail diagram at VM scale: this VM's networks as
// rails, the VM's card under the first with a leg to each (labelled with
// the interface), the switch at each rail's right end. Same layout, colors
// and pills as the Virtual topology and the topology page's Logical tab.

/** The card's heading over whatever it holds - the map, its loader or its
 * empty state - in the detail page's section-title style. */
function TopologySection({ children }: { children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Topology
      </h2>
      {children}
    </section>
  )
}

/** VM-centric slice of the network topology: this VM's interfaces → the
 * networks (VLANs) they're on → the virtual switch each rides. Multi-homing
 * shows one rail per network, in the same style as the topology page. */
type Conn = {
  key: string
  ifaceName: string
  vlan: {
    id: string
    vlan_id: number
    name: string
    color?: string | null
    zone?: { color: string } | null
    status?: StatusMini | null
  } | null
  net: VirtNetwork | null
}

export function VmTopologyCard({
  vmId,
  vmName,
  syncedFromId,
}: {
  vmId: string
  vmName?: string
  /** The tracking virtualization source, when synced - drives the empty-state
   * copy so it never tells the user to enable something already on. */
  syncedFromId?: string | null
}) {
  const ifaces = useQuery({
    queryKey: ["vm-interfaces", vmId],
    queryFn: () =>
      api<Paginated<VMInterface>>(`/api/vm-interfaces/?vm=${vmId}`),
  })
  // The sync's direct NIC-to-network links. This is the primary source:
  // vCenter never states a VLAN on a NIC, so inferring through VLANs left
  // every vCenter VM looking unmapped (#46).
  const nets = useQuery({
    queryKey: ["virt-networks", "vm", vmId],
    queryFn: () =>
      api<Paginated<VirtNetwork>>(`/api/virt-networks/?vm=${vmId}`),
  })
  const source = useQuery({
    queryKey: ["virt-source", syncedFromId],
    queryFn: () =>
      api<{ sync_networks: boolean; name: string }>(
        `/api/virtualization-sources/${syncedFromId}/`
      ),
    enabled: !!syncedFromId,
  })

  const { conns, model } = useMemo(() => {
    const found: Conn[] = []
    const seen = new Set<string>()
    // The VM as the sync reports it on a network: its status and role.
    let self: VirtNetwork["vms"][number] | undefined
    for (const net of nets.data?.results ?? []) {
      for (const v of net.vms) {
        if (v.id !== vmId) continue
        self ??= v
        const ifaceName = v.iface ?? ""
        const k = `${net.id}:${ifaceName}`
        if (seen.has(k)) continue
        seen.add(k)
        found.push({ key: k, ifaceName, vlan: net.vlan ?? null, net })
      }
    }
    // Operator-modelled interfaces with a VLAN but no sync link still render.
    for (const i of ifaces.data?.results ?? []) {
      if (!i.vlan) continue
      if (found.some((c) => c.ifaceName === i.name)) continue
      found.push({
        key: `vlan:${i.id}`,
        ifaceName: i.name,
        vlan: i.vlan,
        net: null,
      })
    }
    const rails: RailModel = {
      sections: [
        {
          id: "vm",
          rails: found.map((c) => {
            const name =
              c.net?.name || c.vlan?.name || c.net?.ext_key || "network"
            const sw = c.net?.vswitch_name
            return {
              id: c.key,
              label: name + (c.vlan ? ` · VLAN ${c.vlan.vlan_id}` : ""),
              // The network's VLAN color already falls back to its zone's;
              // an interface's own VLAN says so itself.
              color: c.vlan?.color || c.vlan?.zone?.color,
              status: c.vlan?.status ?? null,
              // The switch it rides, unless the network is named after it.
              ...(sw && sw !== name ? { detail: sw } : {}),
              ...(c.vlan
                ? { target: { kind: "vlan" as const, id: c.vlan.id } }
                : {}),
            }
          }),
        },
      ],
      // This VM's own card: no link, this is its page.
      boxes: [
        {
          id: vmId,
          name: vmName ?? self?.name ?? "This VM",
          vm: true,
          role: self?.role ?? null,
          status: self?.status_mini ?? null,
          legs: found.map((c) => ({ rail: c.key, label: c.ifaceName })),
        },
      ],
    }
    return { conns: found, model: rails }
  }, [nets.data, ifaces.data, vmId, vmName])

  if (ifaces.isLoading || nets.isLoading)
    return (
      <TopologySection>
        <Loading />
      </TopologySection>
    )
  if (conns.length === 0)
    return (
      <TopologySection>
        <EmptyState title="No virtual networks yet.">
          {source.data?.sync_networks ? (
            "Run a sync on its source."
          ) : syncedFromId ? (
            <>
              Turn on{" "}
              <span className="font-medium">
                Sync virtual switches &amp; networks
              </span>{" "}
              on its source.
            </>
          ) : (
            "Assign a VLAN to one of its interfaces."
          )}
        </EmptyState>
      </TopologySection>
    )

  return (
    <TopologySection>
      <RailFrame model={model} label="Topology" />
    </TopologySection>
  )
}
