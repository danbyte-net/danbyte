import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { MonitoringEngine, Paginated } from "@/lib/api"
import { FormSelect } from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"

const INHERIT = "__inherit__"

/** Assign the monitoring engine (Outpost) that runs checks for a site or
 * location. Saves immediately on change via the engine-binding endpoint — the
 * assignment is independent of the form's own save. Render only for an existing
 * object (needs its id). */
export function MonitoringEngineField({
  scope,
  objectId,
}: {
  scope: "site" | "location"
  objectId: string
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
    { value: INHERIT, label: "Inherit (default)" },
    ...(engines.data?.results ?? [])
      .filter((e) => e.enabled)
      .map((e) => ({
        value: e.id,
        label: e.is_local ? "Local (built-in)" : e.name,
      })),
  ]

  return (
    <FormSelect
      label="Monitoring engine"
      hint={
        scope === "location"
          ? "Which engine runs checks here — overrides the site's."
          : "Which engine runs checks here (an Outpost for a remote site). Inherit follows the tenant default."
      }
      value={binding.data?.engine_id ?? INHERIT}
      onChange={(v) => save.mutate(!v || v === INHERIT ? null : v)}
      options={options}
    />
  )
}
