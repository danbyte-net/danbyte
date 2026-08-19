import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// The three object types a certificate assigns to, and where each type's
// picker list lives (mirrors cert-drift's endpoint→object walk). Devices and
// VMs expose the compact ?picker=1 shape; IPs have no picker shape, so the
// first page of the standard list feeds the combobox.
type AssignType = "api.device" | "api.virtualmachine" | "api.ipaddress"

const TYPES: { value: AssignType; label: string; endpoint: string }[] = [
  { value: "api.device", label: "Device", endpoint: "/api/devices/?picker=1" },
  {
    value: "api.virtualmachine",
    label: "Virtual machine",
    endpoint: "/api/virtual-machines/?picker=1",
  },
  {
    value: "api.ipaddress",
    label: "IP address",
    endpoint: "/api/ips/?page_size=500",
  },
]

interface PickRow {
  id: string
  name?: string
  ip_address?: string
  dns_name?: string
}

/**
 * The "Assign to…" control on a certificate's Assignments tab - the inverse of
 * the per-object CertificatesPanel. Pick an object type (device / VM / IP) and
 * an object of that type, and declare that it should present this certificate.
 * The generic `(object_type, object_id)` target is exactly what the cert-drift
 * resolver compares against.
 */
export function CertificateObjectPicker({
  certificateId,
  onAssigned,
}: {
  certificateId: string
  onAssigned: () => void
}) {
  const [type, setType] = useState<AssignType>("api.device")
  const [objectId, setObjectId] = useState<string | null>(null)

  const spec = TYPES.find((t) => t.value === type)!
  const list = useQuery({
    queryKey: ["cert-assign-objects", type],
    queryFn: () => api<Paginated<PickRow>>(spec.endpoint),
    staleTime: 60_000,
  })

  const options = useMemo<ComboboxOption[]>(
    () =>
      (list.data?.results ?? []).map((o) => ({
        value: o.id,
        label:
          o.ip_address != null
            ? o.dns_name
              ? `${o.ip_address} · ${o.dns_name}`
              : o.ip_address
            : (o.name ?? o.id),
      })),
    [list.data]
  )

  const assign = useMutation({
    mutationFn: () =>
      api("/api/monitoring/certificate-assignments/", {
        method: "POST",
        body: JSON.stringify({
          certificate: certificateId,
          object_type: type,
          object_id: objectId,
          notes: "",
        }),
      }),
    onSuccess: () => {
      toast.success("Certificate assigned")
      setObjectId(null)
      onAssigned()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        value={type}
        onValueChange={(v) => {
          setType(v as AssignType)
          setObjectId(null)
        }}
      >
        <SelectTrigger className="h-9 w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TYPES.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="min-w-56 flex-1">
        <Combobox
          value={objectId}
          onChange={setObjectId}
          options={options}
          placeholder={`Pick a ${spec.label.toLowerCase()}…`}
          searchPlaceholder="Search…"
          emptyText="No objects."
        />
      </div>
      <Button
        type="button"
        size="sm"
        disabled={!objectId || assign.isPending}
        onClick={() => assign.mutate()}
      >
        <Plus className="h-3.5 w-3.5" /> Assign
      </Button>
    </div>
  )
}
