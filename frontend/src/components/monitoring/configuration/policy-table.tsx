import { useCallback, useMemo, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import {
  api,
  type MonitoringPolicy,
  type MonitoringPolicyScope,
  type Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { useMonitoringConfig } from "./config-context"
import { FilteredTable } from "./filtered-table"
import { PolicyControls, type SavePolicy } from "./policy-controls"

export type PolicyColumnContext<T> = {
  controls: (row: T) => ReactNode
}

// Generic scope tab (devices / device types / device roles): the scope's
// objects with a trailing per-row monitoring policy control.
export function PolicyTable<T extends { id: string }>({
  scope,
  endpoint,
  tableId,
  exportName,
  buildColumns,
}: {
  scope: MonitoringPolicyScope
  endpoint: string
  tableId: string
  exportName: string
  buildColumns: (ctx: PolicyColumnContext<T>) => ColumnDef<T>[]
}) {
  const rows = useQuery({
    queryKey: ["monitoring-policy-rows", scope, endpoint],
    queryFn: () => api<Paginated<T>>(endpoint),
  })
  const { templates, profiles, policies } = useMonitoringConfig()
  const policyByTarget = usePolicyMap(policies, scope)
  const { save, pendingId } = usePolicySave(scope, policyByTarget, [
    ["monitoring-policies"],
  ])

  const columns = useMemo<ColumnDef<T>[]>(
    () =>
      buildColumns({
        controls: (row) => (
          <PolicyControls
            policy={policyByTarget.get(row.id)}
            row={row}
            templates={templates}
            profiles={profiles}
            save={save}
            pending={pendingId === row.id}
            showTarget
          />
        ),
      }),
    [buildColumns, pendingId, policyByTarget, profiles, save, templates]
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
        tableId={tableId}
        exportName={exportName}
        flexColumn="name"
      />
    </FilteredTable>
  )
}

export function monitoringControlColumn<T>(
  controls: (row: T) => ReactNode
): ColumnDef<T> {
  return {
    id: "monitoring_config",
    header: "Monitoring config",
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => controls(row.original),
  }
}

export function usePolicyMap(
  policies: MonitoringPolicy[],
  scope: MonitoringPolicyScope
) {
  return useMemo(() => {
    const key = targetKey(scope)
    return new Map(
      policies
        .filter((p) => p.scope === scope)
        .map((p) => [String(p[key] ?? ""), p])
    )
  }, [policies, scope])
}

export function usePolicySave<T extends { id: string }>(
  scope: MonitoringPolicyScope,
  byTarget: Map<string, MonitoringPolicy>,
  invalidate: unknown[][]
): { save: SavePolicy<T>; pendingId: string | null } {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({
      row,
      patch,
    }: {
      row: T
      patch: Partial<MonitoringPolicy>
    }) => {
      const existing = byTarget.get(row.id)
      if (existing) {
        return api<MonitoringPolicy>(
          `/api/monitoring/policies/${existing.id}/`,
          {
            method: "PATCH",
            body: JSON.stringify(patch),
          }
        )
      }
      return api<MonitoringPolicy>("/api/monitoring/policies/", {
        method: "POST",
        body: JSON.stringify({
          scope,
          [targetKey(scope)]: row.id,
          enabled: true,
          inherit: true,
          profiles: [],
          templates: [],
          ...patch,
        }),
      })
    },
    // Optimistic: patch the cached policies list so PolicyControls (stateless,
    // derived purely from the cache) flips immediately; roll back on error.
    onMutate: async ({ row, patch }) => {
      await qc.cancelQueries({ queryKey: ["monitoring-policies"] })
      const prev = qc.getQueryData<Paginated<MonitoringPolicy>>([
        "monitoring-policies",
      ])
      if (prev) {
        const existing = byTarget.get(row.id)
        const results = existing
          ? prev.results.map((p) =>
              p.id === existing.id ? { ...p, ...patch } : p
            )
          : [
              ...prev.results,
              {
                id: `optimistic-${row.id}`,
                scope,
                [targetKey(scope)]: row.id,
                enabled: true,
                inherit: true,
                target: "all",
                interval_seconds: null,
                profiles: [],
                templates: [],
                ...patch,
              } as MonitoringPolicy,
            ]
        qc.setQueryData(["monitoring-policies"], { ...prev, results })
      }
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["monitoring-policies"], ctx.prev)
      apiErrorToast(err, "Update failed")
    },
    onSettled: () => {
      for (const queryKey of invalidate) {
        qc.invalidateQueries({ queryKey })
      }
    },
  })
  // v5's `mutate` is referentially stable, so this callback is too — every
  // panel's columns memo depends on `save`, and an unstable identity here
  // rebuilt all column defs (and re-derived the facet rails over ~500 rows)
  // on every render. Don't return a fresh arrow function from this hook.
  const { mutate, isPending, variables } = mutation
  const save = useCallback(
    (args: { row: T; patch: Partial<MonitoringPolicy> }) => mutate(args),
    [mutate]
  )
  // Which row's save is in flight — drives the per-button spinner. Changes
  // only around a mutation (2 column rebuilds per click), not per render.
  const pendingId = isPending ? (variables?.row.id ?? null) : null
  return { save, pendingId }
}

export function targetKey(scope: MonitoringPolicyScope) {
  return scope as "vrf" | "device_type" | "device_role" | "device" | "prefix"
}
