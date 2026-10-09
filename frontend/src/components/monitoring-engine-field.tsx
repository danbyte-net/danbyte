import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { MonitoringEngine, Paginated } from "@/lib/api"
import { Field, FormSelect } from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"
import { useBindingPick } from "@/lib/binding-drafts"
import { isUserInitiated } from "@/lib/user-activation"

const INHERIT = "__inherit__"
const LABEL = "Monitoring engine"
const HINT = "Where checks run"

/** Assign the monitoring engine that runs checks for a device, site, location
 * or prefix, through the engine-binding endpoint. Inside an edit form wrapped in
 * a `BindingDraftsProvider` the pick is written by the form's Save; elsewhere it
 * saves on pick. Render only for an existing object (needs its id).
 *
 * Most specific wins: a device binding beats its location, which beats its
 * prefix, which beats its site. That is what lets one host be answered by a
 * Zabbix without moving the building it sits in.
 *
 * Nothing renders, and so nothing can be saved, until both the stored binding
 * and the engines on offer are known. Inside a form Radix mirrors the select
 * into a hidden native one that reports a change whenever the controlled
 * value changes; a value with no matching option yet settled it on "", which
 * read as the user picking Inherit and wrote the binding away merely by
 * opening the site form (#324). */
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

  const write = async (engineId: string | null) => {
    await api(`/api/monitoring/engine-binding/${scope}/${objectId}/`, {
      method: "PUT",
      body: JSON.stringify({ engine_id: engineId }),
    })
    await qc.invalidateQueries({ queryKey: bindingKey })
  }
  const save = useMutation({
    mutationFn: write,
    onSuccess: () => toast.success("Monitoring engine updated"),
    onError: (e: unknown) => apiErrorToast(e, "Update failed"),
  })
  const current = binding.data?.engine_id ?? null
  const picked = useBindingPick(
    `engine:${scope}:${objectId}`,
    current,
    write,
    save.mutate
  )

  const info =
    scope === "device"
      ? "Overrides the location, prefix and site. Inherit follows them, then the tenant default."
      : scope === "location"
        ? "Overrides the site. Inherit follows it, then the tenant default."
        : "An Outpost for a site the core cannot reach, or a Zabbix engine. Inherit follows the tenant default."

  if (binding.isPending || engines.isPending) {
    return (
      <Field label={LABEL} hint={HINT} info={info}>
        <Loading className="h-9 min-h-0 flex-row justify-start" />
      </Field>
    )
  }
  if (binding.isError || engines.isError) {
    return (
      <Field label={LABEL} hint={HINT} info={info}>
        <QueryError error={binding.error ?? engines.error} />
      </Field>
    )
  }

  const options = [
    { value: INHERIT, label: "Inherit" },
    ...engines.data.results
      .filter((e) => e.enabled)
      .map((e) => ({
        value: e.id,
        label: e.is_local ? "Local" : e.name,
      })),
  ]
  const offered = new Set(options.map((o) => o.value))

  return (
    <FormSelect
      label={LABEL}
      hint={HINT}
      info={info}
      value={picked.value ?? INHERIT}
      onChange={(v) => {
        // Only a pick of an offered row, under a real gesture, is a change
        // worth keeping. The hidden native select reports its own changes -
        // autofill on load (#125), or "" when the stored engine is no longer
        // offered (#324) - and neither is a user clearing the binding.
        if (!v || !offered.has(v) || !isUserInitiated()) return
        picked.pick(v === INHERIT ? null : v)
      }}
      options={options}
      disabled={disabled || save.isPending}
    />
  )
}
