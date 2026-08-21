import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Cloud } from "lucide-react"

import {
  api,
  type Paginated,
  type VirtNetwork,
  type VirtualizationSource,
  type VirtualSwitch,
} from "@/lib/api"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import {
  RailDiagram,
  type BoxInput,
  type SectionInput,
} from "@/components/topology/rail-diagram"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const Route = createFileRoute("/virtual-topology/")({
  component: VirtualTopologyPage,
})

// OpenStack-style rails, drawn by the shared RailDiagram (also behind the
// topology page's Logical view): each network is a full-width bar, VMs sit
// once in the band under their topmost network with a coloured leg to every
// network they attach to.

function VirtualTopologyPage() {
  const [source, setSource] = useState("")
  const nav = useNavigate()

  const sources = useQuery({
    queryKey: ["virtualization-sources", "topology"],
    queryFn: () =>
      api<Paginated<VirtualizationSource>>("/api/virtualization-sources/"),
  })
  const switches = useQuery({
    queryKey: ["virtual-switches", "topology"],
    queryFn: () => api<Paginated<VirtualSwitch>>("/api/virtual-switches/"),
  })
  const networks = useQuery({
    queryKey: ["virt-networks", "topology", source],
    queryFn: () =>
      api<Paginated<VirtNetwork>>(
        `/api/virt-networks/?${new URLSearchParams(source ? { source } : {})}`
      ),
  })

  const swById = useMemo(() => {
    const m = new Map<string, VirtualSwitch>()
    for (const s of switches.data?.results ?? []) m.set(s.id, s)
    return m
  }, [switches.data])

  const groups = useMemo(() => {
    const by = new Map<string, VirtNetwork[]>()
    for (const n of networks.data?.results ?? []) {
      const k = n.vswitch ?? "-"
      const l = by.get(k)
      if (l) l.push(n)
      else by.set(k, [n])
    }
    return [...by.entries()]
  }, [networks.data])

  // Map the virt payload onto the generic rail-diagram inputs: sections are
  // switches (with their uplink adapters), rails are networks (VLAN-sorted),
  // boxes are VMs deduped across every network they attach to.
  const { sections, boxes } = useMemo(() => {
    const sections: SectionInput[] = []
    const byVm = new Map<string, BoxInput>()
    for (const [swId, nets] of groups) {
      const sw = swById.get(swId)
      const sorted = [...nets].sort(
        (a, b) => (a.vlan?.vlan_id ?? 9999) - (b.vlan?.vlan_id ?? 9999)
      )
      sections.push({
        id: swId,
        title: sw?.name ?? "Unassigned networks",
        subtitle: sw?.kind_display ?? "",
        onTitleClick: sw
          ? () => nav({ to: "/virtual-switches/$id", params: { id: swId } })
          : undefined,
        adapters: (sw?.uplink_interfaces ?? []).map((u) => ({
          key: `${swId}:${u.id}`,
          nic: u.name,
          host: u.device.name,
          onClick: () => nav({ to: "/interfaces/$id", params: { id: u.id } }),
        })),
        rails: sorted.map((n) => ({
          id: n.id,
          label:
            (n.name || n.ext_key) +
            (n.vlan ? `  ·  VLAN ${n.vlan.vlan_id}` : ""),
          color: n.vlan?.color || "",
          onClick: n.vlan
            ? () => nav({ to: "/vlans/$id", params: { id: n.vlan!.id } })
            : undefined,
        })),
      })
      for (const n of sorted) {
        for (const vm of n.vms) {
          let b = byVm.get(vm.id)
          if (!b) {
            b = {
              id: vm.id,
              name: vm.name,
              status: vm.status,
              onClick: () =>
                nav({ to: "/virtual-machines/$id", params: { id: vm.id } }),
              legs: [],
            }
            byVm.set(vm.id, b)
          }
          b.legs.push({ railId: n.id, label: vm.iface ?? undefined })
        }
      }
    }
    return { sections, boxes: [...byVm.values()] }
  }, [groups, swById, nav])

  const loading = networks.isLoading || switches.isLoading
  const isEmpty = !loading && groups.length === 0

  return (
    <ListPageShell
      title="Virtual network topology"
      query={networks}
      actions={
        <Select
          value={source || "all"}
          onValueChange={(v) => setSource(v === "all" ? "" : v)}
        >
          <SelectTrigger size="sm" className="h-8 w-52 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {(sources.data?.results ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {isEmpty ? (
        <EmptyState title="No virtual networks to map yet.">
          Turn on{" "}
          <span className="font-medium">
            Sync virtual switches &amp; networks
          </span>{" "}
          on a virtualization source and re-sync - its switches, networks
          (VLANs) and the VMs on them are drawn here.
        </EmptyState>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-muted/10 p-2">
          <RailDiagram
            sections={sections}
            boxes={boxes}
            externalLabel="External network"
          />
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Cloud className="h-3.5 w-3.5" />
        Networks are rails; each VM appears once, connected by a line to every
        network it attaches to. Rail colour follows the VLAN's zone (set a zone
        on the VLAN to pick it); unzoned networks get a palette shade. Click any
        node to open it.
      </div>
    </ListPageShell>
  )
}
