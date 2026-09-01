import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, VRFOption } from "@/lib/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { apiErrorToast } from "@/lib/api-toast"
import { isUserInitiated } from "@/lib/user-activation"

const INHERIT = "__inherit__"

interface VrfBinding {
  scope: string
  object_id: string
  vrf_id: string | null
  vrf_name: string | null
  effective: { id: string; name: string } | null
}

/**
 * The default VRF SNMP-discovered addresses land in, bound at one hierarchy
 * level (device / device_role / device_type / site). Saves on change, like
 * {@link SnmpBindingControl}; "Inherit" clears the binding so the next level
 * up (… → tenant default) answers. Only consulted when the interface itself
 * names no VRF.
 */
export function SnmpVrfControl({
  scope,
  objectId,
  canEdit,
}: {
  scope: "device" | "device_role" | "device_type" | "site"
  objectId: string
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const key = ["snmp-vrf-binding", scope, objectId]
  const binding = useQuery({
    queryKey: key,
    queryFn: () =>
      api<VrfBinding>(`/api/monitoring/snmp-vrf-binding/${scope}/${objectId}/`),
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const set = useMutation({
    mutationFn: (vrfId: string | null) =>
      api<VrfBinding>(`/api/monitoring/snmp-vrf-binding/${scope}/${objectId}/`, {
        method: "PUT",
        body: JSON.stringify({ vrf_id: vrfId }),
      }),
    onSuccess: (b) => {
      qc.setQueryData(key, b)
      toast.success("Default VRF updated")
    },
    onError: (e) => apiErrorToast(e),
  })

  const value = binding.data?.vrf_id ?? INHERIT
  const effective = binding.data?.effective
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const next = v === INHERIT ? null : v
        // Autofill fires a change on the form's hidden native select with no
        // gesture behind it; saving that would wipe the stored binding (#125).
        if (!isUserInitiated() || next === (binding.data?.vrf_id ?? null))
          return
        set.mutate(next)
      }}
      disabled={!canEdit || set.isPending || binding.isPending}
    >
      <SelectTrigger className="h-8 w-60 text-xs">
        <SelectValue placeholder="-" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT}>
          {effective ? `Inherit (${effective.name})` : "Inherit / none"}
        </SelectItem>
        {(vrfs.data?.results ?? []).map((v) => (
          <SelectItem key={v.id} value={v.id}>
            {v.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
