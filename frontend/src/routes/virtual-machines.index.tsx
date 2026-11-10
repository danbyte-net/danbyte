import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type {
  BulkStatusEntry,
  BulkStatusResponse,
  VirtualMachine,
} from "@/lib/api"
import { useServerList } from "@/lib/server-list"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { usePrtgVmStates } from "@/components/columns/prtg-columns"
import { useEolSettings } from "@/components/cells/eol-cell"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"
import {
  AvailabilityFramePicker,
  useSlaStatus,
} from "@/components/monitoring/sla-status"
import { ListPageShell } from "@/components/list-page-shell"
import { wireFacetColumns } from "@/components/table-filters"
import { VmDeleteDialog } from "@/components/vm-delete-dialog"
import { VmBulkBar } from "@/components/vm-bulk-bar"
import { useCanApplyProfiles } from "@/components/device-profile-bulk"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"
import { useSbomExport, useSbomVexExport } from "@/components/sbom-export"

export const Route = createFileRoute("/virtual-machines/")({
  component: VirtualMachinesPage,
  // ?device= narrows to the VMs running on one hypervisor host - the device
  // page's "Virtual machines" row links here (#54).
  validateSearch: (
    s: Record<string, unknown>
  ): {
    device?: string
    platform?: string
    site?: string
    role?: string
    software_version?: string
  } => ({
    device: typeof s.device === "string" ? s.device : undefined,
    // Lifecycle → Versions (#451): a platform and version's VMs.
    platform: typeof s.platform === "string" ? s.platform : undefined,
    site: typeof s.site === "string" ? s.site : undefined,
    role: typeof s.role === "string" ? s.role : undefined,
    software_version:
      typeof s.software_version === "string" ? s.software_version : undefined,
  }),
})

// Stable empty fallback so `columns` (which depends on `monitoring`) keeps its
// identity while the roll-up loads.
const EMPTY_MON: Record<string, BulkStatusEntry> = {}

/** The rail's facets, counted and filtered by the server over every VM
 * (api/list_specs.py). Monitoring, SLA and PRTG come from other requests for
 * the page's rows, so they stay out of the rail and their headers don't
 * sort. */
const VM_FACETS = [
  "cluster",
  "group",
  "status",
  "power",
  "synced_from",
  "site",
  "role",
  "platform",
  "eol",
  "software_version",
  "software_target",
  "vulnerabilities",
  "vuln_kev",
  "tags",
]

function VirtualMachinesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("virtualmachine", "add")
  const canEdit = canDo("virtualmachine", "change")
  const canDelete = canDo("virtualmachine", "delete")
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<VirtualMachine | null>(null)
  const [selected, setSelected] = useState<VirtualMachine[]>([])
  const canProfiles = useCanApplyProfiles()
  const { device } = Route.useSearch()
  const { enabled: eolOn } = useEolSettings()
  const { enabled: vulnsOn } = useVulnSettings()

  // One page at a time from the server (#482).
  const facetColumns = useMemo(
    () => buildVmColumns({ eol: eolOn, vulns: vulnsOn }),
    [eolOn, vulnsOn]
  )
  const list = useServerList<VirtualMachine>({
    endpoint: "/api/virtual-machines/",
    queryKey: "virtual-machines",
    columns: facetColumns,
    facets: VM_FACETS,
    params: { device },
  })
  const { query, rows, selectedValues, toggleValue } = list

  const handleDelete = useCallback((vm: VirtualMachine) => setDeleting(vm), [])

  // Monitoring rolls up across each VM's addresses, like the device list.
  const vmIds = useMemo(() => rows.map((vm) => vm.id), [rows])
  const monQuery = useQuery({
    queryKey: ["vm-monitoring", vmIds],
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ vms: vmIds }),
      }),
    enabled: vmIds.length > 0,
    refetchInterval: 60_000,
  })
  const monitoring = monQuery.data?.statuses ?? EMPTY_MON
  const sla = useSlaStatus("vm", vmIds)
  const prtg = usePrtgVmStates()

  const columns = useMemo<ColumnDef<VirtualMachine>[]>(
    () =>
      wireFacetColumns(
        buildVmColumns({
          selection: true,
          humanIds,
          eol: eolOn,
          vulns: vulnsOn,
          monitoring,
          prtg,
          sla: { entries: sla.entries, frame: sla.frame },
          actions: {
            editTo: "/virtual-machines/$id/edit",
            editParams: (vm) => ({ id: vm.id }),
            canEdit: () => canEdit,
            onDelete: handleDelete,
            canDelete: () => canDelete,
          },
        }),
        selectedValues,
        toggleValue
      ),
    [
      handleDelete,
      canEdit,
      canDelete,
      humanIds,
      eolOn,
      vulnsOn,
      monitoring,
      prtg,
      sla.entries,
      sla.frame,
      selectedValues,
      toggleValue,
    ]
  )

  const { rail, snapshot, restore, activeCount, allIds, total } = list
  // The SBOM covers every VM the list's filters match, on any page.
  const sbomFilter = useCallback(
    async () => ({ virtual_machine: await allIds() }),
    [allIds]
  )
  const sbom = useSbomExport(sbomFilter, total === 0)
  const sbomVex = useSbomVexExport(sbomFilter, total === 0)

  return (
    <ListPageShell
      title="Virtual machines"
      count={query.data ? total : undefined}
      rail={rail}
      savedViews={{
        objectType: "virtualmachine",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <AvailabilityFramePicker value={sla.frame} onChange={sla.setFrame} />
          <TableActions
            ioType="virtualmachine"
            extraExports={sbomVex ? [sbom, sbomVex] : [sbom]}
          />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/virtual-machines/new">Add VM</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        {...list.tableProps}
        flexColumn="primary_ip"
        tableId="virtual-machines"
        onSelectedRowsChange={
          canEdit || canDelete || canProfiles ? setSelected : undefined
        }
        selectedRows={selected}
      />
      <VmDeleteDialog
        vm={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      {(canEdit || canDelete || canProfiles) && (
        <VmBulkBar
          selected={selected}
          onCleared={() => setSelected([])}
          canEdit={canEdit}
          profiles={canProfiles}
          canDelete={canDelete}
        />
      )}
    </ListPageShell>
  )
}
