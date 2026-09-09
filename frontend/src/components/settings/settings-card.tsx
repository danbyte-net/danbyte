import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/**
 * The settings surface primitives.
 *
 * Three problems these fix:
 *
 * 1. **Wasted width.** Settings pages were pinned to `max-w-2xl` inside a
 *    full-width shell, so ~70% of a wide screen was empty. `SettingsGrid` flows
 *    cards into balanced columns instead - the width gets used without any
 *    single form row growing to an unreadable 2000px.
 * 2. **Ambiguous saves.** One "Save" at the bottom of a long page gave no clue
 *    which of the six things above it were about to be written. A `SettingsCard`
 *    owns its own footer save, scoped to that card and labelled with it, and
 *    only lights up when that card is dirty.
 * 3. **Two cards drawing one box.** `OverrideCard` was a second component with
 *    the same border, radius and header, differing only by an inherit switch.
 *    That switch is the more useful card, so it lives here as `inherit` and
 *    `OverrideCard` is a thin alias (#51).
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
    // so a short card never leaves a hole beside a tall one. `[&>*]:mb-4` is the
    // gap between stacked cards within a column (CSS columns have no row-gap).
    //
    // No negative bottom margin here: on every settings page a full-width card
    // follows this grid, and a `-mb-4` collapsed the `space-y-6` gap before it
    // down to a few pixels, jamming that card against the grid.
    <div
      className={cn(
        "columns-1 gap-4 xl:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid",
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
  /** Rendered beside the title - an info tip, a count, a status pill. */
  badge,
  children,
}: {
  title: string
  badge?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="mb-4">
      <h1 className="flex items-center gap-1.5 text-base font-medium">
        {title}
        {badge}
      </h1>
      {children && (
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          {children}
        </p>
      )}
    </div>
  )
}

/** What a card inherits, and whether it currently does. */
export interface SettingsInherit {
  overridden: boolean
  onChange: (v: boolean) => void
  /** What "inherit" currently means - the value it falls back to, read-only. */
  summary: React.ReactNode
  /** Defaults read "Overriding" / "Using deployment default"; a site-level
   * card inherits from the tenant, so it says so. */
  labels?: { on: string; off: string }
}

/**
 * How the body lays its children out.
 *
 * - `stack` (default) - the existing `grid gap-3` of full-width fields.
 * - `rows` - label on the left, control on the right, one `SettingsRow` per
 *   setting. Labels line up into a scannable column and each row has room for
 *   its own one-line explanation, which is where the "why" goes instead of a
 *   parenthetical in the label.
 * - `plain` - padded, but no gap: one child that owns its own spacing.
 * - `flush` - no padding at all, for a list or table that draws its own
 *   edges and should meet the card's border.
 */
export type SettingsLayout = "stack" | "rows" | "plain" | "flush"

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
  /** Overrides the footer verb - default "Save <title>". */
  saveLabel,
  footer,
  /** Turns the card into an inherit/override group. */
  inherit,
  layout = "stack",
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
  inherit?: SettingsInherit
  layout?: SettingsLayout
  className?: string
}) {
  // Inheriting hides the controls: what a card falls back to is a fact to
  // read, not a form to fill in.
  const inheriting = !!inherit && !inherit.overridden

  return (
    // Full-width cards (long tables) are NOT a variant here - put them after the
    // SettingsGrid instead. `column-span: all` inside a multicol container
    // collapses its margins against the balanced columns above, which left no
    // gap above the spanning card.
    <section
      className={cn("rounded-lg border border-border bg-card", className)}
    >
      <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {title}
            {badge}
          </h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {inherit && (
          <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
            {inherit.overridden
              ? (inherit.labels?.on ?? "Overriding")
              : (inherit.labels?.off ?? "Using deployment default")}
            <Switch
              checked={inherit.overridden}
              onCheckedChange={inherit.onChange}
            />
          </label>
        )}
      </header>

      {inheriting ? (
        <div className="p-4 text-sm text-muted-foreground">
          {inherit.summary}
        </div>
      ) : layout === "rows" ? (
        <div className="divide-y divide-border">{children}</div>
      ) : layout === "flush" ? (
        <>{children}</>
      ) : layout === "plain" ? (
        <div className="p-4">{children}</div>
      ) : (
        <div className="grid gap-3 p-4">{children}</div>
      )}

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

/**
 * One setting inside a `layout="rows"` card: its name on the left, its
 * control on the right.
 *
 * `hint` is where the explanation goes. Settings labels stay short and the
 * "why" gets a line of its own, rather than a parenthetical bolted onto the
 * label.
 */
export function SettingsRow({
  label,
  hint,
  /** Set when the row labels exactly one control, so clicking the label
   * focuses it. */
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  const Label = htmlFor ? "label" : "div"
  return (
    <div
      className={cn(
        "grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-4",
        className
      )}
    >
      <div className="min-w-0 sm:pt-1">
        <Label
          htmlFor={htmlFor}
          className="block text-[13px] font-medium text-foreground"
        >
          {label}
        </Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  )
}
