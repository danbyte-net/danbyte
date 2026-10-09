import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { SnmpBinding, SnmpProfileOption } from "@/lib/api"
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
    // The options endpoint, not the credential-store viewset: anyone who may
    // set a binding gets the id/name/version list (#125) - a site-scoped
    // user was 403'd off the full list, so the saved binding rendered as an
    // empty select and read as "not saved".
    queryKey: ["snmp-profile-options"],
    queryFn: () =>
      api<{ results: SnmpProfileOption[] }>(
        "/api/monitoring/snmp-profile-options/"
      ),
    staleTime: 5 * 60_000,
  })
  return { binding, profiles }
}

/**
 * Assign the SNMP profile at one level of the hierarchy (device / device role /
 * device type). Most-specific wins: device → role → type → tenant default
 * (issue #84). Inside an edit form wrapped in a `BindingDraftsProvider` the
 * pick is written by the form's Save; elsewhere it saves on pick.
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

  const write = async (profileId: string | null) => {
    const b = await api<SnmpBinding>(
      `/api/monitoring/snmp-binding/${scope}/${objectId}/`,
      { method: "PUT", body: JSON.stringify({ profile_id: profileId }) }
    )
    qc.setQueryData(["snmp-binding", scope, objectId], b)
    // A device's effective profile may have changed → refresh its SNMP card.
    void qc.invalidateQueries({ queryKey: ["device-snmp", objectId] })
    return b
  }
  const set = useMutation({
    mutationFn: write,
    onSuccess: () => toast.success("SNMP profile updated"),
    onError: (e) => apiErrorToast(e),
  })
  const picked = useBindingPick(
    `snmp:${scope}:${objectId}`,
    binding.data?.profile_id ?? null,
    write,
    set.mutate
  )

  // Nothing renders until both the stored binding and the profiles on offer
  // are known: a select whose value has no option yet makes the form's hidden
  // native select settle on "" and report a change, which read as the user
  // clearing the binding merely by opening the form (#324).
  if (binding.isPending || profiles.isPending) {
    const loading = <Loading className="h-8 min-h-0 w-60 flex-row" />
    return inline ? loading : <div className="space-y-1">{loading}</div>
  }
  if (binding.isError || profiles.isError) {
    return <QueryError error={binding.error ?? profiles.error} />
  }

  const profileList = profiles.data.results
  const offered = new Set([INHERIT, ...profileList.map((p) => p.id)])

  const select = (
    <Select
      value={picked.value ?? INHERIT}
      onValueChange={(v) => {
        // Only a pick of an offered row, under a real gesture, is a change
        // worth keeping. The hidden native select reports its own changes -
        // autofill on load (#125), or "" when the stored profile is no longer
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
