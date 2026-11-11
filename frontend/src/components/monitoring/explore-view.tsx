import { useMemo } from "react"
import { useSearch } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ExploreDimension, ExploreResponse } from "@/lib/api"
import { useUrlPatch } from "@/lib/use-url-state"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { exploreColumns } from "@/components/columns/explore-columns"
import { useMonitoringCrumb } from "./monitoring-tabs"

const DIMENSIONS: { value: ExploreDimension; label: string }[] = [
  { value: "site", label: "Site" },
  { value: "role", label: "Role" },
  { value: "device_type", label: "Device type" },
  { value: "platform", label: "Platform" },
  { value: "device", label: "Device" },
  { value: "prefix", label: "Prefix" },
  { value: "vrf", label: "VRF" },
  { value: "template", label: "Check" },
  { value: "kind", label: "Type" },
]

export const FRAME_TABS = [
  { value: "1", label: "24h" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "365", label: "1y" },
]

/** `days=1` means the last 24 hours, read from hourly rollups. */
export function frameQuery(days: string): string {
  return days === "1" ? "hours=24" : `days=${days}`
}

/**
 * `/monitoring/performance` - the tenant's checks grouped by one dimension,
 * worst availability first, with latency kept per check kind. A group's name
 * opens the checks list filtered to it.
 */
export function ExploreView() {
  const crumb = useMonitoringCrumb()
  const search = useSearch({ strict: false })
  const patch = useUrlPatch()
  const groupBy = (
    DIMENSIONS.some((d) => d.value === search.group_by)
      ? search.group_by
      : "site"
  ) as ExploreDimension
  const days = FRAME_TABS.some((f) => f.value === search.days)
    ? String(search.days)
    : "30"
  const query = useQuery({
    queryKey: ["monitoring-explore", groupBy, days],
    queryFn: () =>
      api<ExploreResponse>(
        `/api/monitoring/explore/?group_by=${groupBy}&${frameQuery(days)}`
      ),
    placeholderData: keepPreviousData,
  })
  const columns = useMemo(() => exploreColumns(groupBy), [groupBy])
  const rows = query.data?.rows ?? []
  return (
    <ListPageShell
      {...crumb}
      title="Explore"
      count={query.data ? rows.length : undefined}
      actions={
        <>
          {/* Nine dimensions are a long fixed list: one select, so the
              header stays one row beside the window. */}
          <Select value={groupBy} onValueChange={(v) => patch({ group_by: v })}>
            <SelectTrigger
              className="h-8 w-40 shrink-0 text-xs"
              aria-label="Group by"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="text-muted-foreground">By</span>
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              {DIMENSIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SegmentedTabs
            label="Window"
            value={days}
            onValueChange={(v) => patch({ days: v })}
            items={FRAME_TABS}
          />
        </>
      }
      query={query}
    >
      <DataTable
        columns={columns}
        data={rows}
        tableId={`monitoring-explore-${groupBy}`}
        autoColumns={false}
        exportName={`monitoring-${groupBy}`}
        exportTitle="Monitoring by group"
        flexColumn="latency"
      />
    </ListPageShell>
  )
}
