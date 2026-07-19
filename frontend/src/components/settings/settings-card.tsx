import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The settings surface primitives.
 *
 * Two problems these fix:
 *
 * 1. **Wasted width.** Settings pages were pinned to `max-w-2xl` inside a
 *    full-width shell, so ~70% of a wide screen was empty. `SettingsGrid` flows
 *    cards into balanced columns instead — the width gets used without any
 *    single form row growing to an unreadable 2000px.
 * 2. **Ambiguous saves.** One "Save" at the bottom of a long page gave no clue
 *    which of the six things above it were about to be written. A `SettingsCard`
 *    owns its own footer save, scoped to that card and labelled with it, and
 *    only lights up when that card is dirty.
 */
export function SettingsGrid({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    // Masonry: cards pack against the one above rather than aligning to a row,
    // so a short card never leaves a hole beside a tall one.
    //
    // `-mb-4` cancels the trailing margin of whichever card ends each column, so
    // the container's bottom edge sits exactly on the last card. Without it the
    // gap to whatever follows depends on which column happened to be taller.
    <div
      className={cn(
        "columns-1 gap-4 xl:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid",
        "-mb-4",
        className
      )}
    >
      {children}
    </div>
  )
}

/** Page title + description above the grid. */
export function SettingsHeader({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="mb-4">
      <h1 className="text-base font-medium">{title}</h1>
      {children && (
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          {children}
        </p>
      )}
    </div>
  )
}

export function SettingsCard({
  title,
  /** Rendered beside the title (a status pill, a count). Kept separate from
   * `title` so the save label can still derive from a plain string. */
  badge,
  description,
  children,
  /** Show a footer with a save scoped to THIS card. Omit for a read-only card
   * or one whose controls save themselves. */
  onSave,
  /** Enables the save + shows the "unsaved" marker. */
  dirty,
  saving,
  /** Overrides the footer verb — default "Save <title>". */
  saveLabel,
  footer,
  className,
}: {
  title: string
  badge?: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  onSave?: () => void
  dirty?: boolean
  saving?: boolean
  saveLabel?: string
  footer?: React.ReactNode
  className?: string
}) {
  return (
    // Full-width cards (long tables) are NOT a variant here — put them after the
    // SettingsGrid instead. `column-span: all` inside a multicol container
    // collapses its margins against the balanced columns above, which left no
    // gap above the spanning card.
    <section
      className={cn("rounded-lg border border-border bg-card", className)}
    >
      <header className="border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {badge}
        </h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="grid gap-3 p-4">{children}</div>
      {(onSave || footer) && (
        <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          {footer}
          {onSave && (
            <>
              {dirty && (
                <span className="text-[11px] text-muted-foreground">
                  Unsaved changes
                </span>
              )}
              <Button
                size="sm"
                className="ml-auto"
                disabled={!dirty || saving}
                onClick={onSave}
              >
                {saving
                  ? "Saving…"
                  : (saveLabel ?? `Save ${title.toLowerCase()}`)}
              </Button>
            </>
          )}
        </footer>
      )}
    </section>
  )
}
