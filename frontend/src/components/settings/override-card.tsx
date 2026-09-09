import { type ReactNode } from "react"

import { SettingsCard } from "@/components/settings/settings-card"

/** A settings group that can inherit the deployment default or be overridden
 * for this tenant. Inheriting renders a compact read-only `summary` of the
 * deployment values; overriding renders the editable `children`.
 *
 * The behaviour lives on `SettingsCard` now (#51) - this is the old call
 * shape, kept so the tenant, tenant-email and site pages keep working while
 * they are converted. New code passes `inherit` to `SettingsCard` directly. */
export function OverrideCard({
  title,
  description,
  overridden,
  onOverriddenChange,
  summary,
  children,
}: {
  title: string
  description?: string
  overridden: boolean
  onOverriddenChange: (v: boolean) => void
  /** What "inherit" currently means - the deployment default, read-only. */
  summary: ReactNode
  children: ReactNode
}) {
  return (
    <SettingsCard
      title={title}
      description={description}
      layout="plain"
      inherit={{ overridden, onChange: onOverriddenChange, summary }}
    >
      {children}
    </SettingsCard>
  )
}
