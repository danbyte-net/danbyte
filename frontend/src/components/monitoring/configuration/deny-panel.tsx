import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ShieldOff } from "lucide-react"
import { toast } from "sonner"

import { api, type MonitoringDenySubnet, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable, SortHeader } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { actionsColumn } from "@/components/columns/actions-column"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FilteredTable } from "./filtered-table"

type Named = { id: string; name: string }

const INHERIT = "__inherit__"

// Prefix deny tab: VRF-scoped CIDRs excluded from monitoring/discovery.
export function DenySubnetsPanel() {
  const qc = useQueryClient()
  const [cidr, setCidr] = useState("")
  const [vrf, setVrf] = useState(INHERIT)

  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<Named>>("/api/vrfs/?page_size=500"),
  })
  const deny = useQuery({
    queryKey: ["monitoring-deny-subnets"],
    queryFn: () =>
      api<Paginated<MonitoringDenySubnet>>("/api/monitoring/deny-subnets/"),
  })
  const create = useMutation({
    mutationFn: () =>
      api<MonitoringDenySubnet>("/api/monitoring/deny-subnets/", {
        method: "POST",
        body: JSON.stringify({
          cidr: cidr.trim(),
          vrf: vrf === INHERIT ? null : vrf,
        }),
      }),
    onSuccess: () => {
      setCidr("")
      qc.invalidateQueries({ queryKey: ["monitoring-deny-subnets"] })
      toast.success("Prefix deny added")
    },
    onError: (err) => apiErrorToast(err, "Update failed"),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/deny-subnets/${id}/`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["monitoring-deny-subnets"] }),
    onError: (err) => apiErrorToast(err, "Update failed"),
  })

  const columns = useMemo<ColumnDef<MonitoringDenySubnet>[]>(
    () => [
      {
        id: "cidr",
        accessorKey: "cidr",
        header: ({ column }) => <SortHeader column={column} label="Subnet" />,
        cell: ({ row }) => (
          <span className="font-mono text-sm">{row.original.cidr}</span>
        ),
      },
      {
        id: "vrf",
        accessorFn: (row) => row.vrf_detail?.name ?? "Global",
        header: ({ column }) => <SortHeader column={column} label="VRF" />,
        meta: {
          facet: {
            kind: "enum",
            label: "VRF",
            get: (row) => row.vrf ?? "__global__",
            formatValue: (_value, row) => ({
              label: row.vrf_detail?.name ?? "Global",
            }),
          },
        },
      },
      actionsColumn<MonitoringDenySubnet>({
        onDelete: (row) => remove.mutate(row.id),
        deleteLabel: "Remove prefix deny",
      }),
    ],
    [remove]
  )
  const { rail, filteredRows } = useTableFilters(
    columns,
    deny.data?.results ?? []
  )

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (cidr.trim()) create.mutate()
        }}
      >
        <Input
          className="h-8 max-w-xs font-mono"
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
          placeholder="10.0.9.0/24"
        />
        <Select value={vrf} onValueChange={setVrf}>
          <SelectTrigger size="sm" className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Global VRF</SelectItem>
            {(vrfs.data?.results ?? []).map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={create.isPending}>
          <ShieldOff data-icon="inline-start" />
          Add prefix deny
        </Button>
      </form>
      <FilteredTable rail={rail}>
        <DataTable
          data={filteredRows}
          columns={columns}
          tableId="monitoring-config-prefix-deny"
          exportName="monitoring-prefix-deny"
        />
      </FilteredTable>
    </div>
  )
}
