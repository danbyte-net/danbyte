import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, SnmpBinding, SnmpProfileOption } from "@/lib/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { apiErrorToast } from "@/lib/api-toast"

const INHERIT = "__inherit__"

const SOURCE_LABEL: Record<string, string> = {
  device: "set on device",
  device_role: "from role",
  device_type: "from type",
  location: "from location",
  site: "from site",
  tenant_default: "tenant default",
}

/**
 * Assign the SNMP profile at one level of the hierarchy (device / device role /
 * device type). Most-specific wins: device → role → type → tenant default
 * (issue #84). On a device, also shows the resolved *effective* profile and
 * where it comes from when nothing is set directly.
 */
export function SnmpBindingControl({
  scope,
  objectId,
  canEdit,
}: {
  scope: SnmpBinding["scope"]
  objectId: string
  canEdit: boolean
}) {
  const qc = useQueryClient()

  const binding = useQuery({
    queryKey: ["snmp-binding", scope, objectId],
    queryFn: () =>
      api<SnmpBinding>(`/api/monitoring/snmp-binding/${scope}/${objectId}/`),
  })
  const profiles = useQuery({
    queryKey: ["snmp-profiles"],
    queryFn: () =>
      api<Paginated<SnmpProfileOption>>("/api/monitoring/snmp-profiles/"),
    staleTime: 5 * 60_000,
  })

  const set = useMutation({
    mutationFn: (profileId: string | null) =>
      api<SnmpBinding>(`/api/monitoring/snmp-binding/${scope}/${objectId}/`, {
        method: "PUT",
        body: JSON.stringify({ profile_id: profileId }),
      }),
    onSuccess: (b) => {
      qc.setQueryData(["snmp-binding", scope, objectId], b)
      // A device's effective profile may have changed → refresh its SNMP card.
      qc.invalidateQueries({ queryKey: ["device-snmp", objectId] })
      toast.success("SNMP profile updated")
    },
    onError: (e) => apiErrorToast(e),
  })

  const value = binding.data?.profile_id ?? INHERIT
  const eff = binding.data?.effective
  const profileList = profiles.data?.results ?? []

  return (
    <div className="space-y-1">
      <Select
        value={value}
        onValueChange={(v) => set.mutate(v === INHERIT ? null : v)}
        disabled={!canEdit || set.isPending}
      >
        <SelectTrigger className="h-8 w-60 text-xs">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>
            {scope === "device" ? "Inherit / tenant default" : "None"}
          </SelectItem>
          {profileList.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name} · {p.version}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {scope === "device" && !binding.data?.profile_id && eff && (
        <p className="text-[11px] text-muted-foreground">
          {eff.profile_name ? (
            <>
              Effective: <span className="font-medium">{eff.profile_name}</span>
              {eff.source ? ` (${SOURCE_LABEL[eff.source] ?? eff.source})` : ""}
            </>
          ) : (
            "No profile resolves — set one here, on the role/type, or a tenant default."
          )}
        </p>
      )}
      {profileList.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No SNMP profiles yet — create one in Settings → SNMP profiles.
        </p>
      )}
    </div>
  )
}
