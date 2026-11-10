import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { VulnPolicy } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { FormCheckbox, FormRow, FormText } from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { SettingsCard } from "@/components/settings/settings-card"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"

// The tenant's vulnerability priority thresholds (#451), on the tenant
// settings page. Shown while the feature is on; a tenant admin edits them
// and the open matches are re-prioritised.

export const POLICY_FIELDS = [
  "fix_first_epss",
  "fix_first_cvss",
  "high_cvss",
  "high_epss_cvss",
  "high_epss",
  "medium_cvss",
] as const
type PolicyField = (typeof POLICY_FIELDS)[number]

type Form = Record<PolicyField, string> & { kev_is_fix_first: boolean }

const num = (v: string | number) => String(Number(v))

function formOf(p: VulnPolicy): Form {
  const out = { kev_is_fix_first: p.kev_is_fix_first } as Form
  for (const f of POLICY_FIELDS) out[f] = num(p[f])
  return out
}

/** Changed fields only, as numbers; null when one is not a number. */
export function policyPatch(
  p: VulnPolicy,
  f: Form
): Record<string, number | boolean> | null {
  const out: Record<string, number | boolean> = {}
  if (f.kev_is_fix_first !== p.kev_is_fix_first)
    out.kev_is_fix_first = f.kev_is_fix_first
  for (const k of POLICY_FIELDS) {
    if (f[k].trim() === "" || !Number.isFinite(Number(f[k]))) return null
    if (Number(f[k]) !== Number(p[k])) out[k] = Number(f[k])
  }
  return out
}

export function VulnerabilityPolicyCard() {
  const settings = useVulnSettings()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["vulnerability-policy"],
    queryFn: () => api<VulnPolicy>("/api/vulnerabilities/policy/"),
    enabled: settings.enabled,
  })
  const [form, setForm] = useState<Form | null>(null)
  useEffect(() => {
    if (q.data) setForm(formOf(q.data))
  }, [q.data])
  const save = useMutation({
    mutationFn: (body: Record<string, number | boolean>) =>
      api<VulnPolicy>("/api/vulnerabilities/policy/", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (p) => {
      qc.setQueryData(["vulnerability-policy"], p)
      qc.invalidateQueries({ queryKey: ["vulnerabilities"] })
      toast.success("Priority thresholds saved")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!settings.enabled) return null
  if (q.isError)
    return (
      <SettingsCard title="Vulnerability priority">
        <QueryError error={q.error} />
      </SettingsCard>
    )
  if (!q.data || !form) return null
  const p = q.data
  const patch = policyPatch(p, form)
  const field = (k: PolicyField, label: string, max: number, info: string) => (
    <FormText
      label={label}
      type="number"
      min={0}
      max={max}
      step={max === 1 ? 0.01 : 0.1}
      value={form[k]}
      onChange={(v) => setForm((f) => (f ? { ...f, [k]: v } : f))}
      disabled={!p.can_change}
      info={info}
    />
  )
  return (
    <SettingsCard
      title="Vulnerability priority"
      description="When a matched record reads as Fix first, High or Medium. Anything below is Low."
      onSave={p.can_change && patch ? () => save.mutate(patch) : undefined}
      dirty={!!patch && Object.keys(patch).length > 0}
      saving={save.isPending}
      saveLabel="Save thresholds"
    >
      <FormCheckbox
        label="CISA KEV entries are Fix first"
        checked={form.kev_is_fix_first}
        onChange={(v) =>
          setForm((f) => (f ? { ...f, kev_is_fix_first: v } : f))
        }
        disabled={!p.can_change}
      />
      <FormRow>
        {field(
          "fix_first_epss",
          "Fix first EPSS",
          1,
          "Fix first also when EPSS and CVSS both reach these."
        )}
        {field(
          "fix_first_cvss",
          "Fix first CVSS",
          10,
          "Fix first also when EPSS and CVSS both reach these."
        )}
      </FormRow>
      <FormRow>
        {field(
          "high_cvss",
          "High CVSS",
          10,
          "High from this CVSS score on, whatever the EPSS."
        )}
        {field(
          "medium_cvss",
          "Medium CVSS",
          10,
          "Medium from this CVSS score on."
        )}
      </FormRow>
      <FormRow>
        {field(
          "high_epss_cvss",
          "High CVSS with EPSS",
          10,
          "High also when CVSS and EPSS both reach these."
        )}
        {field(
          "high_epss",
          "High EPSS",
          1,
          "High also when CVSS and EPSS both reach these."
        )}
      </FormRow>
    </SettingsCard>
  )
}
