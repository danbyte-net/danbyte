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

function useBinding(scope: SnmpBinding["scope"], objectId: string) {
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
  return { binding, profiles }
}

/**
 * Assign the SNMP profile at one level of the hierarchy (device / device role /
 * device type). Most-specific wins: device → role → type → tenant default
 * (issue #84).
 *
 * By default it renders the Select plus a resolved-profile hint stacked below -
 * fine inside a form column. Pass `inline` to render only the Select (for a
 * card header's actions row); render {@link SnmpBindingHint} in the card body
 * instead so the hint text doesn't wrap into the corner.
 */
export function SnmpBindingControl({
  scope,
  objectId,
  canEdit,
  inline = false,
}: {
  scope: SnmpBinding["scope"]
  objectId: string
  canEdit: boolean
  inline?: boolean
}) {
  const qc = useQueryClient()
  const { binding, profiles } = useBinding(scope, objectId)

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
  const profileList = profiles.data?.results ?? []

  const select = (
    <Select
      value={value}
      onValueChange={(v) => set.mutate(v === INHERIT ? null : v)}
      disabled={!canEdit || set.isPending}
    >
      <SelectTrigger className="h-8 w-60 text-xs">
        <SelectValue placeholder="-" />
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
  )

  if (inline) return select

  return (
    <div className="space-y-1">
      {select}
      <SnmpBindingHint scope={scope} objectId={objectId} />
      {profileList.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No SNMP profiles yet - create one in Settings → SNMP profiles.
        </p>
      )}
    </div>
  )
}

/**
 * The resolved-profile / no-profile hint for a binding, left-aligned. Shares the
 * same queries as {@link SnmpBindingControl} (React Query dedupes by key), so it
 * can be rendered in a card body while the Select sits in the header. Returns
 * null when there's nothing to say.
 */
export function SnmpBindingHint({
  scope,
  objectId,
}: {
  scope: SnmpBinding["scope"]
  objectId: string
}) {
  const { binding } = useBinding(scope, objectId)
  const eff = binding.data?.effective
  // Only the concise positive case: an inherited profile resolved. The
  // "set one / none exist yet" guidance lives in the card's InfoTip so the
  // page isn't stacked with setup nags.
  if (scope !== "device" || binding.data?.profile_id || !eff?.profile_name)
    return null
  return (
    <p className="text-[11px] text-muted-foreground">
      Effective: <span className="font-medium">{eff.profile_name}</span>
      {eff.source ? ` (${SOURCE_LABEL[eff.source] ?? eff.source})` : ""}
    </p>
  )
}
