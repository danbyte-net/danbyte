import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { HostPackagePage } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { DataTable } from "@/components/data-table"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { useUrlTableFilters } from "@/components/table-filters"
import { buildHostPackageColumns } from "@/components/columns/inventory-columns"
import {
  TRANSPORT_LABELS,
  useDiscoveryStatus,
} from "@/components/discovery/status"
import { InfoTip } from "@/components/ui/info-tip"
import { Badge } from "@/components/ui/badge"

// The Packages tab on a device or VM (#451 B2): what discovery's last full
// read found installed. Shown only while Discovery is on and something has
// been read; the vulnerabilities these packages match are on the
// Vulnerabilities tab (Via: Package).

export type PackageHost = "device" | "virtual_machine"

const PATH: Record<PackageHost, string> = {
  device: "devices",
  virtual_machine: "virtual-machines",
}

const TABLE_ID: Record<PackageHost, string> = {
  device: "device-packages",
  virtual_machine: "vm-packages",
}

function packagesUrl(kind: PackageHost, id: string, pageSize?: number): string {
  const q = pageSize ? `?page_size=${pageSize}` : ""
  return `/api/${PATH[kind]}/${id}/packages/${q}`
}

/** Whether the host has a Packages tab, and how many packages it shows. */
export function usePackagesTab(kind: PackageHost, id: string) {
  const { canDo } = useMe()
  const status = useDiscoveryStatus()
  const on = !!status.data?.active && canDo("installedsoftware", "view")
  const head = useQuery({
    queryKey: ["host-packages", kind, id, "head"],
    queryFn: () => api<HostPackagePage>(packagesUrl(kind, id, 1)),
    enabled: on,
  })
  const count = head.data?.count ?? 0
  return { show: on && count > 0, count }
}

const OS_BUILD_FLAG_TIPS: Record<string, string> = {
  product_unknown:
    "This build could not be placed among Microsoft's Windows products, so Microsoft's data is not matched to it.",
  ubr_unknown:
    "The host did not report its update build revision (UBR), so Microsoft's data is not matched to it.",
}

/** Windows: the open OS-build CVEs, or why Microsoft's data does not apply. */
export function OsBuildNote({
  value,
}: {
  value?: HostPackagePage["os_build"]
}) {
  if (!value) return null
  if (value.flag)
    return (
      <span className="flex items-center gap-1">
        OS build not matched
        <InfoTip>{OS_BUILD_FLAG_TIPS[value.flag] ?? value.flag}</InfoTip>
      </span>
    )
  if (value.open === 0) return null
  return (
    <Badge variant="warning" className="num">
      {value.open} open OS-build {value.open === 1 ? "CVE" : "CVEs"}
    </Badge>
  )
}

export function PackagesTab({ kind, id }: { kind: PackageHost; id: string }) {
  const q = useQuery({
    queryKey: ["host-packages", kind, id],
    queryFn: () =>
      apiAll<HostPackagePage["results"][number]>(packagesUrl(kind, id)),
  })
  const head = useQuery({
    queryKey: ["host-packages", kind, id, "head"],
    queryFn: () => api<HostPackagePage>(packagesUrl(kind, id, 1)),
  })
  const columns = useMemo(() => buildHostPackageColumns(), [])
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const {
    rail,
    columns: wired,
    filteredRows,
  } = useUrlTableFilters(columns, rows)
  const os = head.data?.os

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {os && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="text-foreground">
              {os.pretty_name || os.os_id}
            </span>
            {os.ecosystem && <span className="font-mono">{os.ecosystem}</span>}
            {os.build && (
              <span>
                Build{" "}
                <span className="font-mono text-foreground">
                  {os.build}
                  {os.ubr != null ? `.${os.ubr}` : ""}
                </span>
              </span>
            )}
            {os.display_version && <span>{os.display_version}</span>}
            {os.os_id === "windows" && (
              <span className="flex items-center gap-1">
                {os.hotfixes.length}{" "}
                {os.hotfixes.length === 1 ? "hotfix" : "hotfixes"}
                {os.hotfixes.length > 0 && (
                  <InfoTip>
                    <span className="font-mono">
                      {os.hotfixes.map((h) => h.id).join(", ")}
                    </span>
                  </InfoTip>
                )}
              </span>
            )}
            {os.transport && (
              <span>{TRANSPORT_LABELS[os.transport] ?? os.transport}</span>
            )}
            <span className="flex items-center gap-1">
              Read <TimeCell iso={os.collected_at} />
            </span>
            <OsBuildNote value={head.data?.os_build} />
          </p>
        )}
        <DataTable
          tableId={TABLE_ID[kind]}
          data={filteredRows}
          total={q.data?.count}
          columns={wired}
          flexColumn="name"
          searchable
          searchPlaceholder="Search packages…"
          exportName={TABLE_ID[kind]}
          autoColumns={false}
        />
      </div>
    </div>
  )
}
