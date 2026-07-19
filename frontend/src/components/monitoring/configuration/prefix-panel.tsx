import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ChevronDown, Radar, Radio } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type MonitoringEngine,
  type Paginated,
  type Prefix,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { ColorBadge } from "@/components/cells/color-badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useMonitoringConfig } from "./config-context"
import { FilteredTable } from "./filtered-table"
import { PolicyControls } from "./policy-controls"
import {
  monitoringControlColumn,
  usePolicyMap,
  usePolicySave,
} from "./policy-table"

type EngineBinding = { engine_id: string | null }

// Prefix tab: the canonical prefix columns (same factory as /prefixes and
// the detail-page panes) plus the monitoring-specific engine binding and
// policy control columns, grouped by VRF.
export function PrefixPolicyTable() {
  const rows = useQuery({
    queryKey: ["monitoring-policy-rows", "prefix"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/?page_size=500"),
  })
  const { templates, profiles, policies, engines } = useMonitoringConfig()
  const policyByTarget = usePolicyMap(policies, "prefix")
  const { save: savePolicy, pendingId } = usePolicySave(
    "prefix",
    policyByTarget,
    [["monitoring-policies"], ["monitoring-policy-rows", "prefix"]]
  )
  const toggleDiscover = usePrefixDiscoverToggle()
  const discoverPendingId = toggleDiscover.isPending
    ? (toggleDiscover.variables?.id ?? null)
    : null

  const columns = useMemo<ColumnDef<Prefix>[]>(
    () => [
      ...buildPrefixColumns<Prefix>({
        // VRF renders as the group banner (hidden vrfName column); monitoring
        // status has its own page — this tab is about configuration.
        omit: ["vrf"],
        vrfGroupColumn: true,
      }),
      {
        id: "engine",
        accessorFn: (row) => row.monitoring_engine?.name ?? "Inherit",
        header: "Engine",
        enableSorting: false,
        cell: ({ row }) => (
          <EngineBindingMenu prefix={row.original} engines={engines} />
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Engine",
            get: (row: Prefix) => row.monitoring_engine?.id ?? "__inherit__",
            formatValue: (_value, row) => ({
              label: row.monitoring_engine?.name ?? "Inherit",
            }),
          },
        },
      },
      monitoringControlColumn<Prefix>((row) => (
        <PolicyControls
          policy={policyByTarget.get(row.id)}
          row={row}
          templates={templates}
          profiles={profiles}
          save={savePolicy}
          pending={pendingId === row.id}
          discover={{
            active: row.auto_discover,
            pending: discoverPendingId === row.id,
            onClick: () =>
              toggleDiscover.mutate({
                id: row.id,
                next: !row.auto_discover,
              }),
          }}
        />
      )),
    ],
    [
      discoverPendingId,
      engines,
      pendingId,
      policyByTarget,
      profiles,
      savePolicy,
      templates,
      toggleDiscover,
    ]
  )
  const allRows = rows.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <FilteredTable
      rail={rail}
      loading={rows.isLoading}
      error={rows.isError ? rows.error : undefined}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        groupBy="vrfName"
        renderGroupHeader={renderVrfGroupHeader}
        initialColumnVisibility={{ vrfName: false }}
        tableId="monitoring-config-prefixes"
        exportName="monitoring-prefix-policies"
        flexColumn="description"
        pagedWhenGrouped
      />
    </FilteredTable>
  )
}

function usePrefixDiscoverToggle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) =>
      api<Prefix>(`/api/prefixes/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ auto_discover: next }),
      }),
    // Optimistic: flip auto_discover on the cached prefix row; roll back on
    // error. Same reasoning as usePolicySave.
    onMutate: async ({ id, next }) => {
      await qc.cancelQueries({
        queryKey: ["monitoring-policy-rows", "prefix"],
      })
      const prev = qc.getQueryData<Paginated<Prefix>>([
        "monitoring-policy-rows",
        "prefix",
      ])
      if (prev) {
        qc.setQueryData(["monitoring-policy-rows", "prefix"], {
          ...prev,
          results: prev.results.map((p) =>
            p.id === id ? { ...p, auto_discover: next } : p
          ),
        })
      }
      return { prev }
    },
    onSuccess: (_prefix, vars) => {
      toast.success(
        vars.next ? "Subnet discovery enabled" : "Subnet discovery disabled"
      )
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev)
        qc.setQueryData(["monitoring-policy-rows", "prefix"], ctx.prev)
      apiErrorToast(err, "Update failed")
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["monitoring-policy-rows", "prefix"] })
    },
  })
}

function renderVrfGroupHeader({
  value,
  count,
  sampleRow,
}: {
  value: unknown
  count: number
  sampleRow: Prefix
}) {
  const vrf = sampleRow.vrf
  const isGlobal = vrf === null
  return (
    <>
      <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
        VRF
      </span>
      <ColorBadge
        name={isGlobal ? "Global" : vrf!.name || String(value)}
        color={vrf?.color || undefined}
      />
      {vrf?.rd && (
        <span className="font-mono text-[10px] tracking-normal text-muted-foreground/80 normal-case">
          RD {vrf.rd}
        </span>
      )}
      <span className="ml-1 tracking-normal text-muted-foreground/70 normal-case">
        {count} {count === 1 ? "row" : "rows"}
      </span>
    </>
  )
}

function EngineBindingMenu({
  prefix,
  engines,
}: {
  prefix: Prefix
  engines: MonitoringEngine[]
}) {
  const qc = useQueryClient()
  const current = prefix.monitoring_engine
  const save = useMutation({
    mutationFn: (engineId: string | null) =>
      api<EngineBinding>(
        `/api/monitoring/engine-binding/prefix/${prefix.id}/`,
        {
          method: "PUT",
          body: JSON.stringify({ engine_id: engineId }),
        }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monitoring-policy-rows", "prefix"] })
      toast.success("Subnet engine updated")
    },
    onError: (err) => apiErrorToast(err, "Update failed"),
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {current?.is_local ? (
            <Radio data-icon="inline-start" />
          ) : (
            <Radar data-icon="inline-start" />
          )}
          {current?.name ?? "Inherit"}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Subnet engine</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => save.mutate(null)}>
          Inherit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {engines
          .filter((engine) => engine.enabled)
          .map((engine) => (
            <DropdownMenuItem
              key={engine.id}
              onSelect={() => save.mutate(engine.id)}
            >
              {engine.is_local ? <Radio /> : <Radar />}
              <span>{engine.is_local ? "Local (built-in)" : engine.name}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
