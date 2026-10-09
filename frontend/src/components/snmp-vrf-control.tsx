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
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"
import { useBindingPick } from "@/lib/binding-drafts"
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
 * level (device / device_role / device_type / site). Saves like
 * {@link SnmpBindingControl}: by the form's Save inside an edit form, on pick
 * elsewhere. "Inherit" clears the binding so the next level
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
  const write = async (vrfId: string | null) => {
    const b = await api<VrfBinding>(
      `/api/monitoring/snmp-vrf-binding/${scope}/${objectId}/`,
      { method: "PUT", body: JSON.stringify({ vrf_id: vrfId }) }
    )
    qc.setQueryData(key, b)
    return b
  }
  const set = useMutation({
    mutationFn: write,
    onSuccess: () => toast.success("Default VRF updated"),
    onError: (e) => apiErrorToast(e),
  })
  const picked = useBindingPick(
    `vrf:${scope}:${objectId}`,
    binding.data?.vrf_id ?? null,
    write,
    set.mutate
  )

  // Nothing renders until both the stored binding and the VRFs on offer are
  // known: a select whose value has no option yet makes the form's hidden
  // native select settle on "" and report a change, which read as the user
  // clearing the binding merely by opening the form (#324).
  if (binding.isPending || vrfs.isPending) {
    return <Loading className="h-8 min-h-0 w-60 flex-row" />
  }
  if (binding.isError || vrfs.isError) {
    return <QueryError error={binding.error ?? vrfs.error} />
  }

  const effective = binding.data.effective
  const vrfList = vrfs.data.results
  const offered = new Set([INHERIT, ...vrfList.map((v) => v.id)])
  return (
    <Select
      value={picked.value ?? INHERIT}
      onValueChange={(v) => {
        // Only a pick of an offered row, under a real gesture, is a change
        // worth keeping. The hidden native select reports its own changes -
        // autofill on load (#125), or "" when the stored VRF is no longer
        // offered (#324) - and neither is a user clearing the binding.
        if (!v || !offered.has(v) || !isUserInitiated()) return
        picked.pick(v === INHERIT ? null : v)
      }}
      disabled={!canEdit || set.isPending}
    >
      <SelectTrigger className="h-8 w-60 text-xs">
        <SelectValue placeholder="-" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT}>
          {effective ? `Inherit (${effective.name})` : "Inherit / none"}
        </SelectItem>
        {vrfList.map((v) => (
          <SelectItem key={v.id} value={v.id}>
            {v.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
