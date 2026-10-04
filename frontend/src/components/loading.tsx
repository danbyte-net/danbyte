import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * The one loading state: the first-load splash spinner with a small muted
 * "Loading…" under it, centred in whatever it is loading - a page body, a
 * section, a side panel, a map canvas. It fills its parent's box (and keeps a
 * minimum height in one that has none), so the caller only places it.
 *
 * `label={false}` keeps the text for screen readers only; the first-load
 * splash uses that, so it stays the bare spinner it has always been.
 *
 * Pending buttons are not this: they keep their size and swap the verb
 * ("Saving…"). A spinner on its own belongs only in an icon-only button.
 */
export function Loading({
  className,
  label = true,
}: {
  className?: string
  label?: boolean
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex h-full min-h-24 w-full flex-1 flex-col items-center justify-center gap-2",
        className
      )}
    >
      {/* The wrapper is the status; the icon is decoration. */}
      <Spinner
        role="presentation"
        aria-label={undefined}
        aria-hidden
        className="size-5 text-zinc-400 dark:text-zinc-500"
      />
      <span className={label ? "text-xs text-muted-foreground" : "sr-only"}>
        Loading…
      </span>
    </div>
  )
}
