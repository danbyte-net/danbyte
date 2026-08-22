import { useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A labelled run of form fields - the cure for the flat twenty-input scroll.
 *
 * Container-aware: in a narrow container (dialogs, small screens) sections
 * stack - heading above fields. In a wide one (`@3xl`, i.e. a full edit
 * page whose form is marked `@container`) each section becomes a settings
 * row: title rail on the left, fields on the right, hairline between rows.
 *
 * `collapsible` sections render the heading as a disclosure; pass
 * `hasValues` so a section whose fields are set starts open (an edit must
 * never hide data behind a closed disclosure) and shows a dot while closed.
 */
export function FormSection({
  title,
  collapsible,
  hasValues,
  summary,
  children,
}: {
  title: string
  collapsible?: boolean
  /** Any field inside is set - opens the section and marks the closed row. */
  hasValues?: boolean
  /** Terse "what's set in here" line shown while collapsed ("10G · MTU 9000")
   * - the section stays readable without expanding; clicking it opens. */
  summary?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(!collapsible || !!hasValues)

  const headingClasses =
    "flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase " +
    "border-b border-border pb-1.5 @3xl:border-b-0 @3xl:pb-0"

  const heading = collapsible ? (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className={cn(headingClasses, "hover:text-foreground")}
    >
      <ChevronDown
        className={cn(
          "size-3 shrink-0 opacity-60 transition-transform",
          !open && "-rotate-90"
        )}
      />
      {title}
      {!open && hasValues && !summary && (
        <span
          className="size-1.5 rounded-full bg-primary/70"
          aria-label="Has values"
        />
      )}
    </button>
  ) : (
    <h3 className={headingClasses}>{title}</h3>
  )

  return (
    <section
      className={cn(
        "grid content-start gap-3",
        "@3xl:grid-cols-[180px_minmax(0,1fr)] @3xl:gap-x-10 @3xl:gap-y-0",
        "@3xl:border-t @3xl:border-border @3xl:pt-4 @3xl:first:border-t-0 @3xl:first:pt-0"
      )}
    >
      <div className="@3xl:pt-1">{heading}</div>
      {open ? (
        <div className="grid content-start gap-3">{children}</div>
      ) : summary ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="truncate text-left text-xs text-muted-foreground hover:text-foreground @3xl:pt-1.5"
        >
          {summary}
        </button>
      ) : null}
    </section>
  )
}
