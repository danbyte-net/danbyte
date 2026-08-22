import { useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A labelled run of form fields - the cure for the flat twenty-input scroll.
 * Heading matches KvCard's section style. `collapsible` sections render a
 * disclosure row instead; pass `hasValues` so a section whose fields are set
 * starts open (an edit must never hide data behind a closed disclosure) and
 * shows a dot while closed, marking that something inside is configured.
 */
export function FormSection({
  title,
  collapsible,
  hasValues,
  children,
}: {
  title: string
  collapsible?: boolean
  /** Any field inside is set - opens the section and marks the closed row. */
  hasValues?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(!collapsible || !!hasValues)

  if (!collapsible)
    return (
      <section className="grid gap-3">
        <h3 className="border-b border-border pb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {children}
      </section>
    )

  return (
    <section className="grid gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 border-b border-border pb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform",
            !open && "-rotate-90"
          )}
        />
        {title}
        {!open && hasValues && (
          <span
            className="size-1.5 rounded-full bg-primary/70"
            aria-label="Has values"
          />
        )}
      </button>
      {open && children}
    </section>
  )
}
