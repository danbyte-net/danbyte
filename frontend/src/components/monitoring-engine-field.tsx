import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { MonitoringEngine, Paginated } from "@/lib/api"
import { FormSelect } from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"
import { isUserInitiated } from "@/lib/user-activation"

const INHERIT = "__inherit__"

/** Assign the monitoring engine that runs checks for a device, site, location
 * or prefix. Saves immediately on change via the engine-binding endpoint - the
 * assignment is independent of the form's own save. Render only for an existing
 * object (needs its id).
 *
 * Most specific wins: a device binding beats its location, which beats its
 * prefix, which beats its site. That is what lets one host be answered by a
 * Zabbix without moving the building it sits in. */
export function MonitoringEngineField({
  scope,
  objectId,
  disabled = false,
}: {
  scope: "device" | "site" | "location" | "prefix"
  objectId: string
  /** No change grant: render read-only instead of a select whose value snaps
   * back after a refused PUT - which reads as "not saved" (#125). */
  disabled?: boolean
}) {
  const qc = useQueryClient()
  const bindingKey = ["engine-binding", scope, objectId]

  const engines = useQuery({
    queryKey: ["engine-picker"],
    queryFn: () => api<Paginated<MonitoringEngine>>("/api/monitoring/engines/"),
    staleTime: 60_000,
  })
  const binding = useQuery({
    queryKey: bindingKey,
    queryFn: () =>
      api<{ engine_id: string | null }>(
        `/api/monitoring/engine-binding/${scope}/${objectId}/`
      ),
  })

  const save = useMutation({
    mutationFn: (engineId: string | null) =>
      api(`/api/monitoring/engine-binding/${scope}/${objectId}/`, {
        method: "PUT",
        body: JSON.stringify({ engine_id: engineId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bindingKey })
      toast.success("Monitoring engine updated")
    },
    onError: (e: unknown) => apiErrorToast(e, "Update failed"),
  })

  const options = [
    { value: INHERIT, label: "Inherit" },
    ...(engines.data?.results ?? [])
      .filter((e) => e.enabled)
      .map((e) => ({
        value: e.id,
        label: e.is_local ? "Local" : e.name,
      })),
  ]

  return (
    <FormSelect
      label="Monitoring engine"
      hint="Where checks run"
      info={
        scope === "device"
          ? "Overrides the location, prefix and site. Inherit follows them, then the tenant default."
          : scope === "location"
            ? "Overrides the site. Inherit follows it, then the tenant default."
            : "An Outpost for a site the core cannot reach, or a Zabbix engine. Inherit follows the tenant default."
      }
      value={binding.data?.engine_id ?? INHERIT}
      onChange={(v) => {
        const next = !v || v === INHERIT ? null : v
        // Autofill fires a change on the form's hidden native select with no
        // gesture behind it; saving that would wipe the stored binding (#125).
        if (!isUserInitiated() || next === (binding.data?.engine_id ?? null))
          return
        save.mutate(next)
      }}
      options={options}
      disabled={disabled || binding.isPending}
    />
  )
}
