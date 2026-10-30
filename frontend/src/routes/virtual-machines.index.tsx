import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  BulkStatusEntry,
  BulkStatusResponse,
  VirtualMachine,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { usePrtgVmStates } from "@/components/columns/prtg-columns"
import { useEolSettings } from "@/components/cells/eol-cell"
import {
  AvailabilityFramePicker,
  useSlaStatus,
} from "@/components/monitoring/sla-status"
import { ListPageShell } from "@/components/list-page-shell"
import { useUrlTableFilters } from "@/components/table-filters"
import { VmDeleteDialog } from "@/components/vm-delete-dialog"
import { VmBulkBar } from "@/components/vm-bulk-bar"
import { useCanApplyProfiles } from "@/components/device-profile-bulk"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

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

  const query = useQuery({
    queryKey: ["virtual-machines", q, device],
    queryFn: () =>
      apiAll<VirtualMachine>(
        `/api/virtual-machines/?${new URLSearchParams({
          search: q,
          ...(device ? { device } : {}),
        }).toString()}`
      ),
  })

  const handleDelete = useCallback((vm: VirtualMachine) => setDeleting(vm), [])

  // Monitoring rolls up across each VM's addresses, like the device list.
  const vmIds = useMemo(
    () => (query.data?.results ?? []).map((vm) => vm.id),
    [query.data]
  )
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

  const { enabled: eolOn } = useEolSettings()
  const columns = useMemo<ColumnDef<VirtualMachine>[]>(
    () =>
      buildVmColumns({
        selection: true,
        humanIds,
        eol: eolOn,
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
    [
      handleDelete,
      canEdit,
      canDelete,
      humanIds,
      eolOn,
      monitoring,
      prtg,
      sla.entries,
      sla.frame,
    ]
  )

  const allRows = query.data?.results ?? []
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Virtual machines"
      count={query.data ? filteredRows.length : undefined}
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
          <TableActions ioType="virtualmachine" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/virtual-machines/new">Add VM</Link>
            </Button>
          )}
        </>
      }
      query={query}
      page={query.data}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="primary_ip"
        tableId="virtual-machines"
        onSelectedRowsChange={
          canDelete || canProfiles ? setSelected : undefined
        }
        selectedRows={selected}
      />
      <VmDeleteDialog
        vm={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      {(canDelete || canProfiles) && (
        <VmBulkBar
          selected={selected}
          onCleared={() => setSelected([])}
          profiles={canProfiles}
          canDelete={canDelete}
        />
      )}
    </ListPageShell>
  )
}
