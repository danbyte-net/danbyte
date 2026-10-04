import { useMemo } from "react"

import type { VirtualMachine } from "@/lib/api"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"
import { StatusBadge } from "@/components/status-badge"

export interface VMPickerProps extends Omit<ObjectPickerProps, "label"> {
  /** Field label (defaults to "Virtual machine"). */
  label?: string
}

/** The virtual-machine preset of ObjectPicker - combobox plus the
 * advanced-search modal (cluster / site / status / role, server-side). */
export function VMPicker({
  label = "Virtual machine",
  ...rest
}: VMPickerProps) {
  const spec = useMemo<ObjectPickerSpec<VirtualMachine>>(
    () => ({
      noun: "virtual machine",
      pickerEndpoint: "/api/virtual-machines/?picker=1",
      pickerQueryKey: ["vms-picker"],
      detailEndpoint: (id) => `/api/virtual-machines/${id}/`,
      detailQueryKey: (id) => ["virtual-machine", id],
      listEndpoint: "/api/virtual-machines/",
      searchHint: "Search name, description…",
      filters: [
        {
          key: "cluster",
          label: "Cluster",
          endpoint: "/api/clusters/?picker=1",
          queryKey: "clusters-picker",
        },
        {
          key: "site",
          label: "Site",
          endpoint: "/api/sites/?picker=1",
          queryKey: "sites-picker",
        },
        {
          key: "role",
          label: "Role",
          endpoint: "/api/device-roles/?picker=1",
          queryKey: "device-roles-picker",
        },
      ],
      columns: [
        { header: "Name", cell: (v) => v.name },
        {
          header: "Cluster",
          cell: (v) => (
            <span className="text-muted-foreground">{v.cluster.name}</span>
          ),
        },
        {
          header: "Site",
          cell: (v) => (
            <span className="text-muted-foreground">{v.site?.name ?? "-"}</span>
          ),
        },
        { header: "Status", cell: (v) => <StatusBadge status={v.status} /> },
      ],
    }),
    []
  )
  return <ObjectPicker<VirtualMachine> spec={spec} label={label} {...rest} />
}
