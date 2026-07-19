import { type ReactNode } from "react"

import { Switch } from "@/components/ui/switch"

/** A settings group that can inherit the deployment default or be overridden
 * for this tenant. Inheriting renders a compact read-only `summary` of the
 * deployment values; overriding renders the editable `children`. */
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
  /** What "inherit" currently means — the deployment default, read-only. */
  summary: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-background">
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
          {overridden ? "Overriding" : "Using deployment default"}
          <Switch checked={overridden} onCheckedChange={onOverriddenChange} />
        </label>
      </div>
      <div className="p-4">
        {overridden ? (
          children
        ) : (
          <div className="text-sm text-muted-foreground">{summary}</div>
        )}
      </div>
    </section>
  )
}
