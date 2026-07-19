import * as React from "react"

/**
 * Titled detail-page section — the uppercase mini-heading used by KvCard, the
 * SNMP tab, and the monitoring summary, with optional count, badge,
 * description, and right-aligned actions. One component so every tab on a
 * detail page reads identically.
 */
export function Section({
  title,
  count,
  badge,
  description,
  actions,
  children,
}: {
  title: React.ReactNode
  /** Muted "· N" after the title (tabular figures). */
  count?: number
  /** Extra element right after the title (e.g. a status Badge). */
  badge?: React.ReactNode
  /** Muted helper text after the heading. */
  description?: React.ReactNode
  /** Right-aligned controls (buttons, copy, pickers). */
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex min-h-6 flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          {title}
          {count != null && (
            <span className="num tracking-normal text-muted-foreground normal-case">
              · {count}
            </span>
          )}
        </h2>
        {badge}
        {description && (
          <span className="text-[11px] text-muted-foreground normal-case">
            {description}
          </span>
        )}
        {actions && (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </section>
  )
}
