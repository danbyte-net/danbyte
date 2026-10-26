import { useQuery } from "@tanstack/react-query"

import { ApiError } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { PrtgConnection, PrtgSavePlan, PrtgSync } from "@/lib/api"
import { FormSelect, FormText } from "@/components/forms"

export const PRTG_SYNC_OPTIONS: { value: PrtgSync; label: string }[] = [
  { value: "inherit", label: "Follow policies" },
  { value: "always", label: "Monitor in PRTG" },
  { value: "never", label: "Exclude from PRTG" },
]

/** The tenant's PRTG connections, for the forms' hint. Empty when the
 * viewer may not read them. */
function usePrtgConnectionList() {
  return useQuery({
    queryKey: ["prtg-connections"],
    queryFn: async () => {
      try {
        return await apiAll<PrtgConnection>("/api/prtg/connections/")
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404))
          return {
            results: [] as PrtgConnection[],
            count: 0,
            next: null,
            previous: null,
          }
        throw e
      }
    },
    staleTime: 60_000,
  })
}

/** What happens to a planned change, by the connections' Apply
 * automatically switch. */
export function prtgApplyHint(connections: PrtgConnection[]): string {
  const live = connections.filter((c) => c.enabled)
  if (!live.length) return ""
  return live.every((c) => c.auto_apply_registration)
    ? "Applied automatically"
    : "Planned changes wait in the Review queue"
}

/** The toast after a save that changed the PRTG setting. */
export function prtgSaveToast(plan?: PrtgSavePlan | null): string | null {
  if (!plan) return null
  if (plan.state === "applying") return "Being added to PRTG"
  if (plan.state === "planned") return "Planned for PRTG"
  if (plan.state === "attention")
    return "Planned for PRTG; it needs attention first"
  if (plan.state === "excluded") return "Excluded from PRTG"
  return null
}

/** Whether PRTG should have this device or VM: the policies decide, or the
 * object overrules them either way. Under it, what happens to a planned
 * change, and the host PRTG polls. */
export function PrtgSyncSelect({
  value,
  onChange,
  error,
  host,
  onHostChange,
  hostError,
}: {
  value: PrtgSync
  onChange: (v: PrtgSync) => void
  error?: string
  host?: string
  onHostChange?: (v: string) => void
  hostError?: string
}) {
  const connections = usePrtgConnectionList()
  const hint = prtgApplyHint(connections.data?.results ?? [])
  return (
    <>
      <div className="grid gap-1">
        <FormSelect
          label="PRTG"
          info="Follow policies lets the PRTG policies and Register all decide. Monitor in PRTG plans it whatever they say; Exclude from PRTG keeps it out of every plan."
          value={value}
          onChange={(v) => onChange((v ?? "inherit") as PrtgSync)}
          options={PRTG_SYNC_OPTIONS}
          error={error}
        />
        {hint && value !== "never" && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="prtg-apply-hint"
          >
            {hint}
          </p>
        )}
      </div>
      {onHostChange && value !== "never" && (
        <FormText
          label="PRTG polls"
          info="The address or DNS name PRTG polls. Defaults to the primary address. Also how Danbyte finds the device in PRTG."
          value={host ?? ""}
          onChange={onHostChange}
          placeholder="Primary address"
          mono
          error={hostError}
        />
      )}
    </>
  )
}
