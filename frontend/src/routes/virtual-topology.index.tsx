import { createFileRoute } from "@tanstack/react-router"
import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link as LinkIcon } from "lucide-react"

import { useUrlText } from "@/lib/use-url-state"

import { api } from "@/lib/api"
import type {
  Paginated,
  VirtNetwork,
  VirtualizationSource,
  VirtualSwitch,
} from "@/lib/api"
import { copyWithToast } from "@/lib/clipboard"
import { railRoles } from "@/lib/diagram/rails"
import type {
  RailBoxSpec,
  RailModel,
  RailSectionSpec,
} from "@/lib/diagram/rails"
import { usePageTitle } from "@/lib/page-title"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { BarButton } from "@/components/map-toolbar"
import { QueryError } from "@/components/query-error"
import { RailCanvas } from "@/components/topology/rail-diagram"
import { RailLegend, railLegendRows } from "@/components/topology/rail-legend"
import { Combobox } from "@/components/ui/combobox"
import { InfoTip } from "@/components/ui/info-tip"

export const Route = createFileRoute("/virtual-topology/")({
  component: VirtualTopologyPage,
  validateSearch: (s: Record<string, unknown>): { source?: string } =>
    typeof s.source === "string" && s.source ? { source: s.source } : {},
})

// OpenStack-style rails, drawn by the shared rail diagram (also behind the
// topology page's Logical tab and a VM's Topology card): each network is a
// full-width rail, grouped under its switch with the switch's host NICs, and
// each VM sits once in the band under its topmost network with a leg to
// every network it attaches to. A Maps page: a header, a second bar (Copy
// link) and the diagram filling the rest, its legend in the corner.

const NAME = "Virtual topology"

/** The networks as a rail model: sections are switches (with their host
 * NICs), rails their networks by VLAN, cards the VMs, each drawn once. */
function virtualModel(
  networks: readonly VirtNetwork[],
  swById: ReadonlyMap<string, VirtualSwitch>
): RailModel {
  const groups = new Map<string, VirtNetwork[]>()
  for (const n of networks) {
    const k = n.vswitch ?? "-"
    const l = groups.get(k)
    if (l) l.push(n)
    else groups.set(k, [n])
  }
  const sections: RailSectionSpec[] = []
  const byVm = new Map<string, RailBoxSpec>()
  for (const [swId, nets] of groups) {
    const sw = swById.get(swId)
    const sorted = [...nets].sort(
      (a, b) => (a.vlan?.vlan_id ?? 9999) - (b.vlan?.vlan_id ?? 9999)
    )
    sections.push({
      id: swId,
      title: sw?.name ?? "Unassigned networks",
      subtitle: sw?.kind_display ?? "",
      ...(sw ? { target: { kind: "vswitch" as const, id: swId } } : {}),
      adapters: (sw?.uplink_interfaces ?? []).map((u) => ({
        key: `${swId}:${u.id}`,
        nic: u.name,
        host: u.device.name,
        target: { kind: "interface" as const, id: u.id },
      })),
      rails: sorted.map((n) => ({
        id: n.id,
        label:
          (n.name || n.ext_key) + (n.vlan ? ` · VLAN ${n.vlan.vlan_id}` : ""),
        color: n.vlan?.color,
        status: n.vlan?.status ?? null,
        ...(n.vlan ? { target: { kind: "vlan" as const, id: n.vlan.id } } : {}),
      })),
    })
    for (const n of sorted)
      for (const vm of n.vms) {
        let b = byVm.get(vm.id)
        if (!b) {
          b = {
            id: vm.id,
            name: vm.name,
            vm: true,
            role: vm.role ?? null,
            status: vm.status_mini ?? null,
            target: { kind: "vm", id: vm.id },
            legs: [],
          }
          byVm.set(vm.id, b)
        }
        b.legs.push({ rail: n.id, label: vm.iface ?? undefined })
      }
  }
  return {
    sections,
    boxes: [...byVm.values()],
    external: "External network",
  }
}

function VirtualTopologyPage() {
  usePageTitle(NAME)
  // URL-backed, so one source's diagram is a link.
  const [source, setSource] = useUrlText("source")

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

  const model = useMemo(() => {
    if (!networks.data || !switches.data) return null
    const swById = new Map(switches.data.results.map((s) => [s.id, s]))
    return virtualModel(networks.data.results, swById)
  }, [networks.data, switches.data])
  const legend = useMemo(
    () =>
      model
        ? railLegendRows("virtual", {
            roles: railRoles(model),
            adapters: model.sections.some((s) => s.adapters?.length),
          })
        : [],
    [model]
  )

  const loading = networks.isLoading || switches.isLoading
  const failed = networks.isError
    ? networks
    : switches.isError
      ? switches
      : null
  const empty = !model || model.sections.length === 0

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6">
        <h1 className="shrink-0 text-base font-semibold">{NAME}</h1>
        <InfoTip side="bottom">
          Each network is a rail. A VM is drawn once, with a leg to every
          network it is on. A rail takes its VLAN&rsquo;s color, else its
          zone&rsquo;s.
        </InfoTip>
        <div className="ml-auto flex shrink-0 items-center gap-2">
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
        </div>
      </header>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 lg:px-6">
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <BarButton
            onClick={() =>
              void copyWithToast(window.location.href, "Link copied")
            }
          >
            <LinkIcon /> Copy link
          </BarButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {failed ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <QueryError error={failed.error} />
          </div>
        ) : loading ? (
          <Loading className="absolute inset-0" />
        ) : empty ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <EmptyState title="No virtual networks yet.">
              Turn on{" "}
              <span className="font-medium">
                Sync virtual switches &amp; networks
              </span>{" "}
              on a virtualization source.
            </EmptyState>
          </div>
        ) : (
          <RailCanvas
            model={model}
            label={NAME}
            legend={<RailLegend rows={legend} />}
          />
        )}
      </div>
    </div>
  )
}
