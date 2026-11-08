import { useMemo } from "react"

import type { CheckStatus, PrtgDefaults } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { FormSection, FormSelect } from "@/components/forms"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"

/** Only the codes an operator may place; the server fixes the rest. */
export function editableOnly(
  map: Record<string, string>,
  defaults?: PrtgDefaults
): Record<string, string> {
  if (!defaults) return {}
  const out: Record<string, string> = {}
  for (const c of defaults.codes) {
    if (!c.fixed && map[c.value]) out[c.value] = map[c.value]
  }
  return out
}

/**
 * PRTG status → Danbyte state, the same control as the Zabbix severity map:
 * one select per code, each option the tenant's own pill. Paused, unknown,
 * no probe and not licensed are listed but fixed to unknown.
 */
export function PrtgStateMapEditor({
  defaults,
  value,
  onChange,
  error,
}: {
  defaults?: PrtgDefaults
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
  error?: string
}) {
  const statusOptions = useMemo(
    () =>
      (defaults?.statuses ?? []).map((o) => ({
        value: o.value,
        label: <CheckStatusBadge status={o.value as CheckStatus} />,
      })),
    [defaults]
  )
  const codes = defaults?.codes ?? []
  const effective = (code: string) =>
    value[code] || defaults?.default_map[code] || "unknown"
  return (
    <FormSection title="Status mapping" card>
      <div className="grid gap-3 @md:grid-cols-3">
        {codes
          .filter((c) => !c.fixed)
          .map((c, i) => (
            <FormSelect
              key={c.value}
              label={c.label}
              info={
                i === 0
                  ? "What each PRTG status means for the Danbyte status. Worst wins across a device's sensors; paused sensors are left out."
                  : undefined
              }
              value={effective(c.value)}
              onChange={(v) => onChange({ ...value, [c.value]: v ?? "up" })}
              options={statusOptions}
            />
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
        <span>Always</span>
        <CheckStatusBadge status="unknown" />
        <span>:</span>
        {codes
          .filter((c) => c.fixed)
          .map((c) => (
            <Badge key={c.value} variant="secondary">
              {c.label}
            </Badge>
          ))}
      </div>
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </FormSection>
  )
}
