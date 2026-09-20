import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { Paginated, VirtualMachineGroup } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"

/** How the hypervisor groups a cluster's VMs - a Cloud Director vApp today,
 * a Proxmox pool or a vCenter folder once those connectors adopt the same
 * model.
 *
 * Read-only here. The sync writes the names; a VM's own group is set on the
 * VM, and a group an operator sets by hand is never overwritten.
 */
export function ClusterVmGroups({ clusterId }: { clusterId: string }) {
  const q = useQuery({
    queryKey: ["cluster-vm-groups", clusterId],
    queryFn: () =>
      api<Paginated<VirtualMachineGroup>>(
        `/api/vm-groups/?cluster=${clusterId}`
      ),
  })
  const rows = q.data?.results ?? []
  const columns = useMemo<ColumnDef<VirtualMachineGroup>[]>(
    () => [
      { accessorKey: "name", header: "Name" },
      {
        id: "kind",
        header: "Kind",
        accessorFn: (g) => g.kind_display,
      },
      {
        accessorKey: "vm_count",
        header: "VMs",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.vm_count}</span>
        ),
      },
      { accessorKey: "description", header: "Description" },
    ],
    []
  )
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No groups. The hypervisor has not reported any, or group sync is off on
        the source.
      </p>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      total={q.data?.count}
      embedded
    />
  )
}
