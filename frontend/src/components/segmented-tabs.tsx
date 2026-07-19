import { cn } from "@/lib/utils"

export interface SegmentedTab<V extends string = string> {
  value: V
  label: React.ReactNode
  /** Optional trailing count, rendered muted (e.g. row counts on a tab). */
  count?: number | string | null
}

/**
 * The canonical Danbyte tab control — a segmented row of buttons where the
 * active tab fills with `bg-muted`. This is the single source of truth for tab
 * styling across the app (list pages, detail pages, section nav). Pages own
 * their own panels; this component only renders the bar and reports changes.
 *
 * It deliberately replaces the older Radix underline tabs so every tabbed
 * surface looks identical.
 */
export function SegmentedTabs<V extends string = string>({
  items,
  value,
  onValueChange,
  className,
}: {
  items: readonly SegmentedTab<V>[]
  value: V
  onValueChange: (value: V) => void
  className?: string
}) {
  return (
    // min-w-0 lets the strip shrink inside flex rows; the overflow then
    // scrolls INSIDE the nav (swipeable on touch, scrollbar hidden) instead
    // of escalating to the page and dragging the whole layout sideways.
    <nav
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {items.map((it) => {
        const active = it.value === value
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onValueChange(it.value)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            {it.label}
            {it.count != null && it.count !== "" && (
              <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                {it.count}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
