import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download } from "lucide-react"

import { api } from "@/lib/api"
import type { NetworkPlan, VirtualizationSource } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  buildPlanConflictColumns,
  buildPlanDuplicateColumns,
  buildPlanNicColumns,
  buildPlanUnusedColumns,
  buildPlanVnetColumns,
} from "@/components/columns/network-plan-columns"
import type { PlanConflict } from "@/components/columns/network-plan-columns"

type Section = "create" | "wrong" | "without" | "unused" | "issues"

/** What Proxmox SDN should look like, from the cables between this source's
 * VMs. Read-only: Danbyte lists it, something else applies it. */
export function NetworkPlanPanel({ source }: { source: VirtualizationSource }) {
  const [device, setDevice] = useState<string | null>(null)
  const [section, setSection] = useState<Section>("create")
  const base = `/api/virtualization-sources/${source.id}/network-plan/`
  // The whole plan feeds the device picker; a picked device refetches its
  // slice (its VM and the VMs it is cabled to).
  const full = useQuery({
    queryKey: ["network-plan", source.id, ""],
    queryFn: () => api<NetworkPlan>(base),
  })
  const scoped = useQuery({
    queryKey: ["network-plan", source.id, device ?? ""],
    queryFn: () => api<NetworkPlan>(`${base}?device=${device}`),
    enabled: !!device,
  })
  const q = device ? scoped : full
  const plan = q.data

  const deviceOptions = useMemo(() => {
    const seen = new Map<string, string>()
    const p = full.data
    if (p)
      for (const row of [...p.nics_wrong_vnet, ...p.nics_without_vnet])
        seen.set(row.device.id, row.device.name)
    return [...seen.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }))
  }, [full.data])

  const columns = useMemo(
    () => ({
      create: buildPlanVnetColumns(),
      nic: buildPlanNicColumns(),
      unused: buildPlanUnusedColumns(),
      dup: buildPlanDuplicateColumns(),
      issues: buildPlanConflictColumns(),
    }),
    []
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading || !plan) return <Loading />

  const issues: PlanConflict[] = [
    ...plan.conflicts,
    ...plan.cables_skipped.map((s) => ({
      kind: "skipped",
      cable: s.cable,
      detail: `Not in the plan: ${s.reason}.`,
    })),
  ]
  const tabs = [
    {
      value: "create" as const,
      label: "VNets to create",
      count: plan.vnets_to_create.length,
    },
    {
      value: "wrong" as const,
      label: "Wrong VNet",
      count: plan.nics_wrong_vnet.length,
    },
    {
      value: "without" as const,
      label: "No VNet",
      count: plan.nics_without_vnet.length,
    },
    {
      value: "unused" as const,
      label: "Unused VNets",
      count: plan.unused_vnets.length,
    },
    {
      value: "issues" as const,
      label: "Issues",
      count: issues.length + plan.duplicates.length,
    },
  ]
  const download = `${base}?format=json${device ? `&device=${device}` : ""}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs
          items={tabs}
          value={section}
          onValueChange={setSection}
        />
        <div className="ml-auto flex items-center gap-2">
          <Combobox
            value={device}
            onChange={setDevice}
            options={deviceOptions}
            noneLabel="All devices"
            placeholder="All devices"
            searchPlaceholder="Search devices…"
            aria-label="Device"
            className="w-56"
          />
          <Button size="sm" variant="outline" asChild>
            <a href={download} download>
              <Download className="h-3.5 w-3.5" />
              JSON
            </a>
          </Button>
        </div>
      </div>
      {plan.notes.map((n) => (
        <p key={n} className="text-xs text-muted-foreground">
          {n}
        </p>
      ))}
      {plan.counts.cables === 0 && issues.length === 0 ? (
        <EmptyState title="No cables between this source's VMs.">
          Set Is router on each VM and cable the devices; each cable is one
          VNet.
        </EmptyState>
      ) : (
        <>
          {section === "create" && (
            <DataTable
              data={plan.vnets_to_create}
              columns={columns.create}
              tableId="network-plan-create"
              flexColumn="cables"
              embedded
            />
          )}
          {section === "wrong" && (
            <DataTable
              data={plan.nics_wrong_vnet}
              columns={columns.nic}
              tableId="network-plan-nics"
              flexColumn="cable"
              embedded
            />
          )}
          {section === "without" && (
            <DataTable
              data={plan.nics_without_vnet}
              columns={columns.nic}
              tableId="network-plan-nics"
              flexColumn="cable"
              embedded
            />
          )}
          {section === "unused" && (
            <DataTable
              data={plan.unused_vnets}
              columns={columns.unused}
              tableId="network-plan-unused"
              flexColumn="alias"
              embedded
            />
          )}
          {section === "issues" && (
            <div className="space-y-4">
              {plan.duplicates.length > 0 && (
                <DataTable
                  data={plan.duplicates}
                  columns={columns.dup}
                  tableId="network-plan-duplicates"
                  flexColumn="cables"
                  embedded
                />
              )}
              <DataTable
                data={issues}
                columns={columns.issues}
                tableId="network-plan-issues"
                flexColumn="detail"
                embedded
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
