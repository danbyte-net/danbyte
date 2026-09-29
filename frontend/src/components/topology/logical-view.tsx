import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Filter, Link as LinkIcon, SlidersHorizontal } from "lucide-react"

import { api } from "@/lib/api"
import type { LogicalTopology, Paginated } from "@/lib/api"
import { copyWithToast } from "@/lib/clipboard"
import { railRoles } from "@/lib/diagram/rails"
import type { RailModel, RailSectionSpec } from "@/lib/diagram/rails"
import { FormCheckbox } from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { BarButton, BarMenuTrigger } from "@/components/map-toolbar"
import { PopoverField } from "@/components/topology/filters-popover"
import { RailCanvas } from "@/components/topology/rail-diagram"
import { RailLegend, railLegendRows } from "@/components/topology/rail-legend"
import { Badge } from "@/components/ui/badge"
import { Combobox } from "@/components/ui/combobox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useUrlFlag, useUrlText } from "@/lib/use-url-state"

// Sentinel key for devices with no group. A printable constant, not an
// embedded NUL - a NUL byte makes git treat this file as binary (#110), and
// as a named constant it cannot collide with a real group name by accident.
const UNGROUPED = "\u0000ungrouped"

// The topology page's Logical tab: VLANs as rails (grouped into their VLAN
// groups), physical devices AND virtual machines attached to the rails their
// interfaces carry - the hybrid L2 picture, drawn by the shared rail diagram.
// Cards take their role's color and wear their status; VMs draw dashed;
// tagged (trunk) attachments draw dashed legs.
//
// Its controls live in the page's own bars, like the other tabs': the header
// renders <LogicalFilters /> (Site, VLAN group) and <LogicalDisplay /> (VMs),
// the second bar is <LogicalBar /> (Copy link), and the canvas area
// is <LogicalTopologyView />. Each reads and writes the URL itself, so the
// page only places them.

/** The Logical tab's URL state. `site` is the SAME `?site=` the Diagram and
 * Hierarchy filter on, so switching tabs keeps the scope you were looking at;
 * "all" is the Any row. */
function useLogicalParams() {
  const [site, setSite] = useUrlText("site", "all")
  const [vlanGroup, setVlanGroup] = useUrlText("vlangroup", "all")
  const [showVms, setShowVms] = useUrlFlag("vms", true)
  return { site, setSite, vlanGroup, setVlanGroup, showVms, setShowVms }
}

type Row = { id: string; name: string }

/** The Logical tab's payload. */
function useLogicalData() {
  const { site, vlanGroup, showVms } = useLogicalParams()
  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (site !== "all") p.set("site", site)
    if (vlanGroup !== "all") p.set("vlan_group", vlanGroup)
    if (!showVms) p.set("include_vms", "0")
    return p.toString()
  }, [site, vlanGroup, showVms])
  return useQuery({
    queryKey: ["topology-logical", qs],
    queryFn: () => api<LogicalTopology>(`/api/topology/logical/?${qs}`),
  })
}

/** The payload as a rail model: sections are VLAN groups, in order of
 * first appearance (rails come vlan_id-sorted from the API), ungrouped
 * VLANs last; cards are devices and VMs, each drawn once. */
function logicalModel(data: LogicalTopology): RailModel {
  const bySection = new Map<string, RailSectionSpec>()
  for (const r of data.rails) {
    const key = r.group ?? UNGROUPED
    let sec = bySection.get(key)
    if (!sec) {
      sec = {
        id: key,
        title: r.group ?? "VLANs",
        subtitle: r.group ? "VLAN group" : "",
        rails: [],
      }
      bySection.set(key, sec)
    }
    sec.rails.push({
      id: r.id,
      label: `${r.name} · VLAN ${r.vlan_id}`,
      color: r.color,
      status: r.status ?? null,
      target: { kind: "vlan", id: r.id },
    })
  }
  const sections = [...bySection.values()].sort((a, b) =>
    a.id === UNGROUPED ? 1 : b.id === UNGROUPED ? -1 : 0
  )
  return {
    sections,
    boxes: data.nodes.map((n) => ({
      id: `${n.kind}:${n.id}`,
      name: n.name,
      vm: n.kind === "vm",
      role: n.role ?? null,
      status: n.status_mini ?? null,
      target: { kind: n.kind === "vm" ? "vm" : "device", id: n.id },
      legs: n.attachments.map((a) => ({
        rail: a.rail,
        label: a.iface,
        dashed: a.tagged,
        // The interface name opens the interface (device interfaces only -
        // VM interfaces have no page of their own).
        ...(a.iface_id
          ? { target: { kind: "interface" as const, id: a.iface_id } }
          : {}),
      })),
    })),
  }
}

const options = (rows: readonly Row[] | undefined) =>
  (rows ?? []).map((r) => ({ value: r.id, label: r.name }))

/** A searchable select with an Any row ("all" ↔ the combobox's none). */
function AnySelect({
  value,
  onChange,
  anyLabel,
  rows,
}: {
  value: string
  onChange: (v: string) => void
  anyLabel: string
  rows: readonly Row[] | undefined
}) {
  return (
    <Combobox
      value={value === "all" ? null : value}
      onChange={(v) => onChange(v ?? "all")}
      options={options(rows)}
      noneLabel={anyLabel}
      placeholder={anyLabel}
      className="h-8 w-full text-xs"
    />
  )
}

/**
 * The Logical tab's header Filters: Site and VLAN group, each with an Any
 * row. Same trigger as the Diagram's Filters, counting the filters in force.
 */
export function LogicalFilters() {
  const { site, setSite, vlanGroup, setVlanGroup } = useLogicalParams()
  // Same cache keys as the page's own pickers.
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<Row>>("/api/sites/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const groups = useQuery({
    queryKey: ["vlan-groups-picker"],
    queryFn: () => api<Paginated<Row>>("/api/vlan-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const active = [site, vlanGroup].filter((v) => v !== "all").length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarMenuTrigger>
          <Filter /> Filters
          {active > 0 && (
            <Badge variant="secondary" className="num h-4 px-1 text-[10px]">
              {active}
            </Badge>
          )}
        </BarMenuTrigger>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 p-3">
        <PopoverField label="Site">
          <AnySelect
            value={site}
            onChange={setSite}
            anyLabel="Any site"
            rows={sites.data?.results}
          />
        </PopoverField>
        <PopoverField label="VLAN group">
          <AnySelect
            value={vlanGroup}
            onChange={setVlanGroup}
            anyLabel="Any VLAN group"
            rows={groups.data?.results}
          />
        </PopoverField>
      </PopoverContent>
    </Popover>
  )
}

/** The Logical tab's header Display: whether VMs are drawn. */
export function LogicalDisplay() {
  const { showVms, setShowVms } = useLogicalParams()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarMenuTrigger>
          <SlidersHorizontal /> Display
        </BarMenuTrigger>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-3">
        <FormCheckbox
          label="VMs"
          checked={showVms}
          onChange={setShowVms}
          className="items-center"
        />
      </PopoverContent>
    </Popover>
  )
}

/** The Logical tab's second bar: the map is its address, so Copy link is
 * all it needs. The bar stays so the canvas doesn't jump between tabs. */
export function LogicalBar() {
  return (
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
  )
}

export function LogicalTopologyView() {
  const q = useLogicalData()
  const model = useMemo(() => (q.data ? logicalModel(q.data) : null), [q.data])
  const legend = useMemo(
    () => (model ? railLegendRows("logical", { roles: railRoles(model) }) : []),
    [model]
  )

  if (q.isLoading) return <Loading className="absolute inset-0" />
  if (q.isError)
    return (
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!model || model.sections.length === 0)
    return (
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <EmptyState title="No VLAN attachments yet." />
      </div>
    )
  return (
    <RailCanvas
      model={model}
      label="Logical topology"
      legend={<RailLegend rows={legend} />}
    />
  )
}
