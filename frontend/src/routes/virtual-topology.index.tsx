import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { useUrlText } from "@/lib/use-url-state"

import {
  api,
  type Paginated,
  type VirtNetwork,
  type VirtualizationSource,
  type VirtualSwitch,
} from "@/lib/api"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  RailDiagram,
  type BoxInput,
  type SectionInput,
} from "@/components/topology/rail-diagram"
import { Combobox } from "@/components/ui/combobox"
import { InfoTip } from "@/components/ui/info-tip"

export const Route = createFileRoute("/virtual-topology/")({
  component: VirtualTopologyPage,
  validateSearch: (s: Record<string, unknown>): { source?: string } =>
    typeof s.source === "string" && s.source ? { source: s.source } : {},
})

// OpenStack-style rails, drawn by the shared RailDiagram (also behind the
// topology page's Logical view): each network is a full-width bar, VMs sit
// once in the band under their topmost network with a coloured leg to every
// network they attach to.

function VirtualTopologyPage() {
  // URL-backed, so one source's diagram is a link.
  const [source, setSource] = useUrlText("source")
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
            (n.name || n.ext_key) + (n.vlan ? ` · VLAN ${n.vlan.vlan_id}` : ""),
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
  const failed = networks.isError
    ? networks
    : switches.isError
      ? switches
      : null

  return (
    // The shell draws only the header: this is a Maps page, so the body
    // keeps the Maps loader and its own error and empty states.
    <ListPageShell
      title="Virtual topology"
      actions={
        <>
          <InfoTip side="bottom">
            Each network is a rail. A VM is drawn once, with a leg to every
            network it is on. A rail takes its VLAN&rsquo;s color, else its
            zone&rsquo;s.
          </InfoTip>
          <Combobox
            value={source || null}
            onChange={(v) => setSource(v ?? "")}
            options={(sources.data?.results ?? []).map((s) => ({
              value: s.id,
              label: s.name,
            }))}
            noneLabel="Any source"
            placeholder="Any source"
            className="h-8 w-52 text-xs"
          />
        </>
      }
    >
      {failed ? (
        <QueryError error={failed.error} />
      ) : loading ? (
        <Loading />
      ) : groups.length === 0 ? (
        <EmptyState title="No virtual networks yet.">
          Turn on{" "}
          <span className="font-medium">
            Sync virtual switches &amp; networks
          </span>{" "}
          on a virtualization source.
        </EmptyState>
      ) : (
        // Capped to the viewport so the diagram scrolls inside its own box -
        // the horizontal bar then sits on screen instead of below a page-high
        // drawing where nobody finds it.
        <div className="max-h-[calc(100vh-16rem)] overflow-auto rounded-lg border border-border bg-muted/10 p-2">
          <RailDiagram
            sections={sections}
            boxes={boxes}
            externalLabel="External network"
          />
        </div>
      )}
    </ListPageShell>
  )
}
